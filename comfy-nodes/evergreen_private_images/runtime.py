"""Small, verified hooks for the installed Comfy execution boundary.

Private jobs have no websocket client, sanitized failures, or reusable cached
pixels/instructions after completion. This releases references; it does not
claim physical RAM/VRAM zeroization.
"""
import logging


def private_graph(graph):
    return any(node.get("class_type", "").startswith("EvergreenPrivate") for node in graph.values())


def install_runtime_boundary(server, executor_class):
    execute = executor_class.execute
    handle_error = executor_class.handle_execution_error
    send_sync = server.send_sync

    def private_execute(self, prompt, prompt_id, extra_data=None, execute_outputs=None):
        private = private_graph(prompt)
        data = extra_data or {}
        if private:
            # Discard caller-supplied fingerprints on generic signed replays.
            # Start empty so no private node can be skipped through a cache hit.
            prompt = {key: {k: v for k, v in node.items() if k != "is_changed"}
                      for key, node in prompt.items()}
            self.reset()
            # Also isolate a signed graph replayed through generic /prompt.
            data = {**data, "client_id": "evergreen-private:" + prompt_id}
        try:
            return execute(self, prompt, prompt_id, data, execute_outputs or [])
        finally:
            if private:
                # Clear every dependency cache, including generated text and pixels.
                success, messages = self.success, self.status_messages
                self.reset()
                self.success, self.status_messages = success, messages
                server.client_id = None

    def private_error(self, prompt_id, prompt, current_outputs, executed, error, ex):
        if private_graph(prompt):
            error = {**error, "exception_message": "Private image processing failed", "traceback": [], "current_inputs": {}}
        return handle_error(self, prompt_id, prompt, current_outputs, executed, error, ex)

    def private_send(event, data, sid=None):
        if isinstance(sid, str) and sid.startswith("evergreen-private:"):
            return
        return send_sync(event, data, sid)

    executor_class.execute = private_execute
    executor_class.handle_execution_error = private_error
    server.send_sync = private_send

    class PrivateLogs(logging.Filter):
        def filter(self, record):
            if isinstance(server.client_id, str) and server.client_id.startswith("evergreen-private:"):
                # Node exception messages and traceback text may echo instructions.
                record.msg = "Private image processing event (details withheld)"
                record.args = ()
                record.exc_info = None
                record.exc_text = None
                record.stack_info = None
            return True

    for handler in logging.getLogger().handlers:
        handler.addFilter(PrivateLogs())
