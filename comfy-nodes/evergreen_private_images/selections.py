"""Bounded geometry from segmentation masks, never a claim of exact matting.

Contours are reviewed and corrected in Core before any editing operation.
No image data, query or model output is written outside encrypted job storage.
"""
import math

import numpy as np

MAX_SUGGESTIONS = 12
MAX_SHAPES = 12
MAX_POINTS = 128


def describe_masks(masks, boxes, query, width, height):
    import cv2

    if masks.ndim != 3 or masks.shape[1:] != (height, width) or len(masks) > MAX_SUGGESTIONS:
        raise ValueError("Invalid segmentation dimensions")
    if not np.isfinite(masks).all():
        raise ValueError("Invalid segmentation values")
    suggestions = []
    for index, mask in enumerate(masks):
        binary = (mask > 0.5).astype(np.uint8)
        contours, hierarchy = cv2.findContours(binary, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)
        if hierarchy is None:
            continue
        # Keep holes and nested islands. If geometry exceeds the reviewed-mask
        # capacity, refuse this suggestion instead of filling holes silently.
        selected = [i for i, contour in enumerate(contours) if cv2.contourArea(contour) >= 4]
        if len(selected) > MAX_SHAPES:
            continue
        shapes = []
        for contour_index in selected:
            contour = contours[contour_index]
            epsilon = 0.00025 * cv2.arcLength(contour, True)
            polygon = cv2.approxPolyDP(contour, epsilon, True)
            while len(polygon) > MAX_POINTS:
                epsilon = max(epsilon * 1.5, 0.1)
                polygon = cv2.approxPolyDP(contour, epsilon, True)
            if len(polygon) < 3:
                continue
            depth, parent = 0, int(hierarchy[0][contour_index][3])
            while parent >= 0:
                depth += 1
                parent = int(hierarchy[0][parent][3])
            shapes.append({"kind": "outline", "operation": "subtract" if depth % 2 else "add",
                "points": [{"x": round(min(1, max(0, float(point[0][0]) / width)), 6),
                            "y": round(min(1, max(0, float(point[0][1]) / height)), 6)} for point in polygon]})
        if not shapes:
            continue
        # findContours TREE orders a parent before its descendants; ordered
        # add/subtract matches Core's existing v1 selection compositor.
        score = float(boxes[index].get("score", 0)) if index < len(boxes) else 0.0
        if not math.isfinite(score) or not 0 <= score <= 1:
            raise ValueError("Invalid segmentation score")
        suggestions.append({"id": str(index + 1), "label": f"{query} {index + 1}",
            "score": score, "shapes": shapes})
    return {"version": 1, "width": width, "height": height, "query": query,
            "approximate": True, "suggestions": suggestions}
