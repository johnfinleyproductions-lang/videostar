"""No GPU, real photos or Comfy install needed for storage lifecycle tests."""
import copy
import hashlib
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
import uuid
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location("private_store", Path(__file__).resolve().parents[1] / "comfy-nodes/evergreen_private_images/store.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
runtime_spec = importlib.util.spec_from_file_location("private_runtime", Path(__file__).resolve().parents[1] / "comfy-nodes/evergreen_private_images/runtime.py")
runtime = importlib.util.module_from_spec(runtime_spec)
runtime_spec.loader.exec_module(runtime)


class PrivateJobTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name).resolve()
        self.key = self.base / "key"
        self.key.write_text("ab" * 32)
        self.key.chmod(0o600)
        self.now = [100.0]
        self.store = module.PrivateJobs(self.base / "jobs", self.key, lambda: self.now[0])
        self.identity = str(uuid.uuid4())
        self.source = b"\x89PNG\r\n\x1a\nsynthetic-private-source"
        self.instruction = "Change the background to blue"
        self.graph = {"1": {"class_type": "EvergreenPrivateImage", "inputs": {"identity": self.identity, "slot": "source", "authorization": ""}},
                      "2": {"class_type": "EvergreenPrivateOutput", "inputs": {"identity": self.identity, "images": ["1", 0], "authorization": ""}}}

    def tearDown(self):
        self.temp.cleanup()

    def reserve(self, **changes):
        args = dict(identity=self.identity, source=self.source, reference=self.source, instruction=self.instruction, seed=10, width=768, height=768)
        args.update(changes)
        return self.store.reserve(**args)

    def active(self):
        self.reserve()
        tag = self.store.authorize_graph(self.identity, self.graph)
        for node in self.graph.values():
            node["inputs"]["authorization"] = tag
        return tag

    def test_authentication_requires_exact_secret(self):
        self.assertTrue(self.store.authenticated("Bearer " + "ab" * 32))
        for token in [None, "Bearer ", "Bearer " + "ac" * 32, "Basic " + "ab" * 32]:
            self.assertFalse(self.store.authenticated(token))

    def test_encrypted_owner_only_files_and_round_trip(self):
        self.reserve()
        self.assertEqual(self.store.read_blob(self.identity, "source"), self.source)
        for file in (self.base / "jobs").rglob("*"):
            self.assertEqual(file.stat().st_mode & 0o077, 0)
            if file.is_file():
                self.assertNotIn(self.source, file.read_bytes())
                self.assertNotIn(self.instruction.encode(), file.read_bytes())

    def test_idempotent_admission_and_different_input_rejected(self):
        self.assertTrue(self.reserve()[1])
        self.assertFalse(self.reserve()[1])
        with self.assertRaises(ValueError):
            self.reserve(seed=11)

    def test_legacy_identity_and_optional_third_input(self):
        manifest, _ = self.reserve()
        old_request = {"source": hashlib.sha256(self.source).hexdigest(), "reference": hashlib.sha256(self.source).hexdigest(),
            "instruction": self.instruction, "seed": 10, "width": 768, "height": 768}
        self.assertEqual(manifest["requestHash"], hashlib.sha256(module.canonical(old_request)).hexdigest())
        self.assertNotIn("operation", manifest)
        self.assertNotIn("reference2", manifest)
        with self.assertRaises(ValueError):
            self.reserve(reference2=self.source)
        identity = str(uuid.uuid4())
        self.reserve(identity=identity, reference2=self.source)
        self.assertEqual(self.store.read_blob(identity, "reference2"), self.source)
        with self.assertRaises(ValueError):
            self.reserve(identity=identity, reference2=self.source + b"changed")
        self.store.erase(identity)
        self.assertFalse(list((self.base / "jobs" / identity).glob("*.sealed")))

    def test_operation_identity_and_single_category_query(self):
        manifest, _ = self.reserve(reference=None, operation="selection", instruction="person")
        self.assertEqual(manifest["operation"], "selection")
        for change in [dict(operation=None, instruction="A person in view"), dict(instruction="cup"), dict(operation="viewpoint")]:
            with self.assertRaises(ValueError):
                self.reserve(reference=None, **change)
        for query in ["", " ", "a" * 121, "person:999999", "cup,person", "person\ncar"]:
            with self.assertRaises(ValueError):
                self.reserve(identity=str(uuid.uuid4()), reference=None, instruction=query, operation="selection")
        for change in [dict(reference=None, reference2=self.source), dict(operation="other"), dict(operation="selection"), dict(operation="viewpoint")]:
            with self.assertRaises(ValueError):
                self.reserve(identity=str(uuid.uuid4()), **change)

    def test_fast_profile_is_immutable_and_progress_matches_its_steps(self):
        manifest, fresh = self.reserve(profile="fast12-v1")
        self.assertTrue(fresh)
        self.assertEqual(manifest["profile"], "fast12-v1")
        self.assertFalse(self.reserve(profile="fast12-v1")[1])
        with self.assertRaises(ValueError):
            self.reserve()
        for profile in ["standard", "fast", "fast4-v1", 12, True]:
            with self.assertRaises(ValueError):
                self.reserve(identity=str(uuid.uuid4()), profile=profile)
        for operation in ["selection", "viewpoint"]:
            with self.assertRaises(ValueError):
                self.reserve(identity=str(uuid.uuid4()), reference=None, profile="fast12-v1", operation=operation)
        self.store.authorize_graph(self.identity, self.graph)
        self.store.progress(self.identity, "sampling", 1, 12)
        self.assertEqual(self.store.status(self.identity)["progress"]["totalSteps"], 12)
        with self.assertRaises(ValueError):
            self.store.progress(self.identity, "sampling", 2, 20)
        self.store.complete(self.identity, self.source)
        restarted = module.PrivateJobs(self.base / "jobs", self.key, lambda: self.now[0])
        self.assertEqual(restarted.status(self.identity)["profile"], "fast12-v1")
        self.assertEqual(restarted.read_blob(self.identity, "output"), self.source)
        restarted.acknowledge(self.identity, hashlib.sha256(self.source).hexdigest())
        self.assertFalse(list((self.base / "jobs" / self.identity).glob("*.sealed")))

    def test_selection_json_is_encrypted_recoverable_and_removed_on_ack(self):
        self.reserve(reference=None, instruction="person", operation="selection")
        self.store.authorize_graph(self.identity, self.graph)
        data = module.canonical({"version": 1, "query": "person", "suggestions": []})
        self.store.complete(self.identity, data)
        restarted = module.PrivateJobs(self.base / "jobs", self.key, lambda: self.now[0])
        self.assertEqual(restarted.read_blob(self.identity, "output"), data)
        self.assertNotIn(data, (self.base / "jobs" / self.identity / "output.sealed").read_bytes())
        restarted.acknowledge(self.identity, hashlib.sha256(data).hexdigest())
        self.assertFalse(list((self.base / "jobs" / self.identity).glob("*.sealed")))

    def test_whole_graph_is_pinned_against_read_or_output_redirection(self):
        tag = self.active()
        self.store.verify_graph(self.identity, tag, self.graph)
        for mutate in [lambda g: g["1"]["inputs"].update(slot="reference"),
                       lambda g: g.update({"3": {"class_type": "SaveImage", "inputs": {"images": ["1", 0]}}}),
                       lambda g: g.pop("2")]:
            modified = copy.deepcopy(self.graph)
            mutate(modified)
            with self.assertRaises(ValueError):
                self.store.verify_graph(self.identity, tag, modified)

    def test_runtime_fingerprint_is_ignored_but_inputs_remain_pinned(self):
        tag = self.active()
        changed = copy.deepcopy(self.graph)
        for node in changed.values():
            node["is_changed"] = [float("nan")]
        self.store.verify_graph(self.identity, tag, changed)
        changed["1"]["inputs"]["is_changed"] = "caller input"
        with self.assertRaises(ValueError):
            self.store.verify_graph(self.identity, tag, changed)

    def test_core_crash_before_ack_keeps_output_but_removes_inputs(self):
        self.active()
        self.store.complete(self.identity, self.source)
        reopened = module.PrivateJobs(self.base / "jobs", self.key, lambda: self.now[0])
        self.assertEqual(reopened.read_blob(self.identity, "output"), self.source)
        self.assertEqual([p.name for p in (self.base / "jobs" / self.identity).iterdir() if p.suffix == ".sealed"], ["output.sealed"])
        receipt = reopened.status(self.identity)["outputSha256"]
        with self.assertRaises(ValueError):
            reopened.acknowledge(self.identity, "0" * 64)
        reopened.acknowledge(self.identity, receipt)
        reopened.acknowledge(self.identity, receipt)
        self.assertFalse(list((self.base / "jobs" / self.identity).glob("*.sealed")))

    def test_erasure_blocks_late_publication_and_resubmission(self):
        tag = self.active()
        self.store.erase(self.identity)
        with self.assertRaises(ValueError):
            self.store.complete(self.identity, self.source)
        with self.assertRaises(ValueError):
            self.store.verify_graph(self.identity, tag, self.graph)
        manifest, fresh = self.reserve()
        self.assertFalse(fresh)
        self.assertEqual(manifest["state"], "consumed")

    def test_restart_fails_processing_and_removes_partial_output(self):
        self.active()
        self.store._write_blob(self.identity, "output", self.source)
        restarted = module.PrivateJobs(self.base / "jobs", self.key, lambda: self.now[0])
        self.assertEqual(restarted.status(self.identity)["state"], "failed")
        self.assertNotIn("progress", restarted.status(self.identity))
        self.assertFalse(list((self.base / "jobs" / self.identity).glob("*.sealed")))

    def test_expiry_and_crash_leftovers_are_scrubbed(self):
        self.active()
        self.store.complete(self.identity, self.source)
        self.now[0] += module.TTL_SECONDS + 1
        self.store.expire()
        self.assertEqual(self.store.status(self.identity)["state"], "expired")
        self.store._write_blob(self.identity, "output", self.source)  # interrupted erasure
        self.store.expire()
        self.assertFalse(list((self.base / "jobs" / self.identity).glob("*.sealed")))
        orphan = self.base / "jobs" / str(uuid.uuid4())
        orphan.mkdir(mode=0o700)
        (orphan / "source.sealed").write_bytes(b"staging-ciphertext")
        self.store.expire()
        self.assertFalse(orphan.exists())

    def test_ciphertext_tamper_and_cross_job_copy_fail(self):
        self.reserve()
        blob = self.base / "jobs" / self.identity / "source.sealed"
        encrypted = blob.read_bytes()
        blob.write_bytes(encrypted[:-1] + bytes([encrypted[-1] ^ 1]))
        with self.assertRaises(Exception):
            self.store.read_blob(self.identity, "source")
        other = str(uuid.uuid4())
        self.reserve(identity=other)
        blob.write_bytes((self.base / "jobs" / other / "source.sealed").read_bytes())
        with self.assertRaises(Exception):
            self.store.read_blob(self.identity, "source")

    def test_paths_modes_and_non_integer_settings_fail_closed(self):
        for value in ["../escape", "/tmp/path", "not-a-uuid"]:
            with self.assertRaises(ValueError):
                self.reserve(identity=value)
        for value in [True, 768.0, "768"]:
            with self.assertRaises(ValueError):
                self.reserve(width=value)
        self.key.chmod(0o644)
        with self.assertRaises(ValueError):
            module.PrivateJobs(self.base / "other", self.key)
        self.key.chmod(0o600)
        (self.base / "linked").symlink_to(self.base / "jobs", target_is_directory=True)
        with self.assertRaises(ValueError):
            module.PrivateJobs(self.base / "linked", self.key)

    def test_runtime_releases_private_cache_preserves_failure_and_hides_events(self):
        sent, errors, starts = [], [], []
        server = SimpleNamespace(client_id=None, send_sync=lambda *args: sent.append(args))

        class Executor:
            def reset(self):
                self.caches = {}
                self.success, self.status_messages = True, []

            def execute(self, prompt, prompt_id, extra_data, outputs):
                if any(node["class_type"].startswith("EvergreenPrivate") for node in prompt.values()):
                    self_test.assertEqual(self.caches, {})
                    self_test.assertTrue(all("is_changed" not in node for node in prompt.values()))
                server.client_id = extra_data.get("client_id")
                self.caches = {"pixels": b"private pixels", "instruction": "private instruction"}
                self.success = False
                self.handle_execution_error(prompt_id, prompt, [], [],
                    {"node_id": "1", "exception_message": "private instruction", "traceback": ["private traceback"], "current_inputs": {"photo": "private pixels"}}, ValueError())
                self.status_messages = ["failure preserved"]
                server.send_sync("execution_error", {"private": "pixels"}, server.client_id)

            def handle_execution_error(self, *args):
                errors.append(args[-2])

        runtime.install_runtime_boundary(server, Executor, lambda graph: starts.append(graph))
        self_test = self
        executor = Executor()
        executor.caches = {"pixels": b"stale cached pixels"}
        graph = copy.deepcopy(self.graph)
        for node in graph.values():
            node["is_changed"] = "caller fingerprint"
        executor.execute(graph, self.identity, {"client_id": "ordinary-client"}, [])
        self.assertFalse(executor.success)
        self.assertEqual(executor.status_messages, ["failure preserved"])
        self.assertEqual(executor.caches, {})
        self.assertEqual(sent, [])
        self.assertEqual(len(starts), 1)
        self.assertEqual(errors[0]["current_inputs"], {})
        self.assertEqual(errors[0]["traceback"], [])
        self.assertNotIn("private instruction", errors[0]["exception_message"])
        ordinary = {"1": {"class_type": "SaveImage", "inputs": {}}}
        executor.execute(ordinary, self.identity, {"client_id": "ordinary-client"}, [])
        self.assertTrue(executor.caches)
        self.assertEqual(len(sent), 1)
        self.assertEqual(len(starts), 1)

    def test_scalar_progress_is_monotonic_bounded_and_erased_with_job(self):
        self.reserve()
        self.store.authorize_graph(self.identity, self.graph)
        self.assertEqual(self.store.status(self.identity)["progress"], {"phase": "queued"})
        self.store.progress(self.identity, "preparing")
        self.store.progress(self.identity, "sampling", 4, 20)
        self.store.progress(self.identity, "sampling", 2, 20)
        self.store.progress(self.identity, "preparing")
        self.assertEqual(self.store.status(self.identity)["progress"], {"phase": "sampling", "completedSteps": 4, "totalSteps": 20})
        for args in [("unknown",), ("sampling", -1, 20), ("sampling", 21, 20), ("sampling", True, 20),
                     ("sampling", 1, 21), ("sampling", 1, 12), ("sampling", 1.5, 20), ("queued", 1, 20)]:
            with self.assertRaises(ValueError):
                self.store.progress(self.identity, *args)
        self.store.progress(self.identity, "finishing")
        self.assertEqual(self.store.status(self.identity)["progress"], {"phase": "finishing"})
        self.store.erase(self.identity, "expired")
        self.store.progress(self.identity, "sampling", 10, 20)
        self.assertNotIn("progress", self.store.status(self.identity))


if __name__ == "__main__":
    unittest.main()
