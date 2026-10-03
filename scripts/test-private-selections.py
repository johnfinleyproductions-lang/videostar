"""Synthetic geometry acceptance; no model loading or private photographs."""
import importlib.util
from pathlib import Path
import unittest

import cv2
import numpy as np

spec = importlib.util.spec_from_file_location("private_selections", Path(__file__).resolve().parents[1] / "comfy-nodes/evergreen_private_images/selections.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SelectionGeometryTests(unittest.TestCase):
    def describe(self, masks, boxes=None):
        return module.describe_masks(masks, boxes or [{"score":0.9}] * len(masks), "person", masks.shape[2], masks.shape[1])

    def test_disconnected_regions_hole_and_nested_island_keep_operation_order(self):
        masks = np.zeros((1,128,128), np.float32)
        masks[0,10:110,10:110] = 1
        masks[0,30:90,30:90] = 0
        masks[0,50:70,50:70] = 1
        result = self.describe(masks)
        self.assertTrue(result["approximate"])
        shapes = result["suggestions"][0]["shapes"]
        self.assertEqual([s["operation"] for s in shapes], ["add", "subtract", "add"])
        self.assertTrue(all(3 <= len(s["points"]) <= 128 for s in shapes))
        self.assertTrue(all(0 <= p[axis] <= 1 for s in shapes for p in s["points"] for axis in ["x","y"]))

    def test_empty_masks_return_empty_suggestions(self):
        self.assertEqual(self.describe(np.zeros((0,128,128), np.float32))["suggestions"], [])
        self.assertEqual(self.describe(np.zeros((1,128,128), np.float32))["suggestions"], [])

    def test_busy_outline_simplifies_without_exceeding_vertex_budget(self):
        masks = np.zeros((1,768,768), np.float32)
        angle = np.linspace(0,2*np.pi,600,endpoint=False)
        radius = 240 + 20*np.sin(angle*60)
        points = np.column_stack([384+radius*np.cos(angle),384+radius*np.sin(angle)]).astype(np.int32)
        cv2.fillPoly(masks[0],[points],1)
        suggestion = self.describe(masks)["suggestions"][0]
        self.assertLessEqual(len(suggestion["shapes"][0]["points"]),128)
        self.assertGreater(len(suggestion["shapes"][0]["points"]),3)

    def test_overcomplex_islands_are_not_silently_filled(self):
        masks = np.zeros((1,128,128), np.float32)
        for i in range(13):
            x,y = 4+(i%4)*30,4+(i//4)*30
            masks[0,y:y+12,x:x+12] = 1
        self.assertEqual(self.describe(masks)["suggestions"], [])

    def test_instances_stay_separate_and_invalid_output_is_rejected(self):
        masks = np.zeros((2,128,128), np.float32)
        masks[0,10:30,10:30] = 1
        masks[1,80:100,80:100] = 1
        result = self.describe(masks,[{"score":.8},{"score":.7}])
        self.assertEqual([s["id"] for s in result["suggestions"]],["1","2"])
        self.assertEqual([s["score"] for s in result["suggestions"]],[.8,.7])
        for bad in [np.zeros((13,128,128)), np.full((1,128,128),np.nan)]:
            with self.assertRaises(ValueError):
                self.describe(bad)
        with self.assertRaises(ValueError):
            self.describe(masks,[{"score":float("inf")}])


if __name__ == "__main__":
    unittest.main()
