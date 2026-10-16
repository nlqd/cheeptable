"""Image degradations shared by the sweeps: each factory returns a function gray uint8 image -> degraded image."""
import cv2
import numpy as np

_rng = np.random.default_rng(0)


def seed(n):
    global _rng
    _rng = np.random.default_rng(n)


def chain(*fns):
    def f(img):
        for fn in fns:
            img = fn(img)
        return img
    return f


def rotate(deg):
    def f(img):
        h, w = img.shape
        m = cv2.getRotationMatrix2D((w / 2, h / 2), deg, 1.0)
        return cv2.warpAffine(img, m, (w, h), flags=cv2.INTER_LINEAR, borderValue=255)
    return f


def blur(sigma):
    return lambda img: cv2.GaussianBlur(img, (0, 0), sigma)


def lowres(factor):
    def f(img):
        h, w = img.shape
        small = cv2.resize(img, (int(w * factor), int(h * factor)), interpolation=cv2.INTER_AREA)
        return cv2.resize(small, (w, h), interpolation=cv2.INTER_LINEAR)
    return f


def jpeg(q):
    def f(img):
        ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, q])
        return cv2.imdecode(buf, cv2.IMREAD_GRAYSCALE)
    return f


def contrast(alpha):
    return lambda img: np.clip(255 - (255 - img.astype(np.float32)) * alpha, 0, 255).astype(np.uint8)


def shadow(img):
    h, w = img.shape
    ramp = np.linspace(1.0, 0.55, w, dtype=np.float32)[None, :]
    return np.clip(img.astype(np.float32) * ramp, 0, 255).astype(np.uint8)


def noise(sigma):
    return lambda img: np.clip(img.astype(np.float32) + _rng.normal(0, sigma, img.shape), 0, 255).astype(np.uint8)


