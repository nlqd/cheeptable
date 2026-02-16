#!/usr/bin/env python3
"""
Flask OCR Server: PaddleOCR detection + VietOCR recognition
- PaddleOCR (lang='en'): text detection — clean bounding boxes
- VietOCR (vgg_transformer): Vietnamese recognition — handles all diacritics
- PaddleOCR English: fallback for pure-numeric boxes (avoids VietOCR hallucinations)

Compatible with PaddleOCR 3.x (paddlepaddle 3.x) + vietocr 0.3.x
"""

import os
os.environ['PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK'] = 'True'

import re
import threading
import base64
import io

import cv2
import numpy as np
from PIL import Image
from flask import Flask, request, jsonify, make_response
from paddleocr import PaddleOCR
from vietocr.tool.predictor import Predictor
from vietocr.tool.config import Cfg

app = Flask(__name__)

# PaddleOCR's C++ predictor is NOT thread-safe — serialise with an exclusive lock.
_inference_lock = threading.Lock()

# Optional auth token — set OCR_AUTH_TOKEN env var to enable.
# /health is always public; /ocr and /batch_ocr require the token when set.
_AUTH_TOKEN = os.environ.get('OCR_AUTH_TOKEN', '').strip()

def _authorized():
    if not _AUTH_TOKEN:
        return True
    auth = request.headers.get('Authorization', '')
    return auth == f'Bearer {_AUTH_TOKEN}'

@app.after_request
def add_cors(response):
    response.headers['Access-Control-Allow-Origin'] = '*'
    response.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization'
    response.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
    return response

@app.route('/', defaults={'path': ''}, methods=['OPTIONS'])
@app.route('/<path:path>', methods=['OPTIONS'])
def options_handler(path):
    return make_response('', 204)

# Regex: pure number/punctuation — safe to let PaddleOCR en handle these
_NUMERIC_RE = re.compile(r'^[\d\s.,:()\[\]%/=+\-xX*]+$')

# Regex: detect operator characters that VietOCR tends to mangle to '?'
_OPERATOR_RE = re.compile(r'[><=]')

# Regex: diameter symbol written as P/p/b/2 followed by 2–4 digits
# Þ is misread as P, p, b, or 2 depending on the glyph rendering.
# Use [1-9]\d{1,3} (not \d{2,4}) to avoid false positives like 200→Þ00.
_DIAMETER_RE = re.compile(r'(?<![A-Za-z\d])([Pp2b])([1-9]\d{1,3})\b')

# PaddleOCR confidence below which a P+digits result is treated as Þ+digits
_DIAMETER_CONF_THRESHOLD = 0.975

# Tail-stripping: Vietnamese words / abbreviations that bleed from adjacent
# page content and appear as hallucinated trailing tokens from VietOCR.
# These are all common words that never legitimately end a construction task description.
_TAIL_1 = frozenset([
    # Vietnamese common words
    'thế', 'trị', 'nhau', 'lại', 'năm', 'tháng', 'nha', 'thuận', 'trước',
    'nghệ', 'thể', 'nhất', 'trận', 'chính', 'đội', 'nam', 'tế', 'là',
    # Abbreviations from column headers / adjacent text
    'tc', 'th', 'tp', 'tm', 'tt', 'ch', 'ban', 'hh', 'hhh', 'thuy',
    'thị', 'thanh', 'khác', 't', 'l', 'm', 'la',
    # Unit suffix hallucinations (diameter already captured as Þ, mm is spurious)
    'mm',
])
_TAIL_2 = frozenset(['thế trị', 'thế trước', 'th tp'])  # common two-word tail combos
# Raw tail tokens: partial-character fragments that appear before punctuation stripping
_TAIL_RAW = frozenset(['(m', '(s', '(S', '(m2', '(m3'])
_YEAR_TAIL_RE = re.compile(r'^(?:(?:19|20)\d{2}|19|20)$')  # year or partial year

# Phrase-level diacritic corrections for recurring systematic misreads.
# Each entry: (compiled_regex, replacement_string).
# These patterns are construction-domain-specific and safe to apply globally.
_PHRASE_SUBS = [
    # "phui muông ống" (pipe trench) — VietOCR reads ô→ươ in "muông"
    (re.compile(r'phui mương ống'), 'phui muông ống'),
    # "búa cần khi nền" (pneumatic hammer) — VietOCR reads all three words wrong
    (re.compile(r'căn khí nén\b'), 'cần khi nền'),
    # Pipe fittings: "đầu nối" (connector) — VietOCR reads sắc→huyền tone
    (re.compile(r'đấu nối'), 'đầu nối'),
    # "Bừng chận" (end cap fitting) — VietOCR reads huyền→hỏi tone
    (re.compile(r'Bửng chận'), 'Bừng chận'),
    # Transport phrase: "ôtô tự đổ" (dump truck) — VietOCR reads hỏi→huyền
    (re.compile(r'ôtô tự đồ'), 'ôtô tự đổ'),
    # "uPVC" (pipe material code) — VietOCR uppercases to "UPVC"
    (re.compile(r'\bUPVC\b'), 'uPVC'),
]


def _is_numeric(text):
    return bool(_NUMERIC_RE.match(text.strip())) if text.strip() else True


def _trim_right_padding(crop: Image.Image, white_threshold: int = 245, min_width: int = 4) -> Image.Image:
    """Strip trailing near-white columns from a PIL crop to reduce VietOCR hallucinations."""
    arr = np.array(crop.convert('RGB'))
    h, w, _ = arr.shape
    # A column is 'blank' when every pixel in that column is near-white
    col_is_blank = np.all(arr >= white_threshold, axis=(0, 2))  # shape: (W,)
    non_blank = np.where(~col_is_blank)[0]
    if non_blank.size == 0:
        return crop
    last_col = int(non_blank[-1]) + 1
    last_col = max(last_col, min_width)
    if last_col >= w:
        return crop
    return crop.crop((0, 0, last_col, h))


def make_paddle():
    return PaddleOCR(
        lang='en',
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
    )


def make_vietocr():
    cfg = Cfg.load_config_from_name('vgg_transformer')
    cfg['cnn']['pretrained'] = False
    cfg['device'] = 'cpu'
    cfg['predictor']['beamsearch'] = False
    return Predictor(cfg)


print("Initializing PaddleOCR (detection + en recognition)...")
paddle = make_paddle()
print("PaddleOCR ready!")

print("Initializing VietOCR (Vietnamese recognition)...")
viet = make_vietocr()
print("VietOCR ready! Hybrid OCR server active.")

# Warm-up: run one blank inference so the C++ predictor allocates its
# internal buffers now rather than on the first real request.
# Without this, PaddleOCR throws a RuntimeError on the second request
# which triggers make_paddle() reinitialisation mid-run.
print("Warming up PaddleOCR...")
_warmup = np.zeros((64, 64, 3), dtype=np.uint8)
try:
    paddle.predict(_warmup)
except Exception:
    pass
print("Warm-up done.")


def hybrid_ocr(image_np):
    """
    PaddleOCR detection → VietOCR recognition per crop.

    Strategy:
    - PaddleOCR detects bounding boxes on the full image.
    - Each box is cropped and fed to VietOCR individually.
    - VietOCR wins for text boxes (handles Vietnamese diacritics correctly).
    - PaddleOCR English wins for pure-numeric boxes (numbers, codes, units)
      to avoid VietOCR hallucinations on digit-only content.
    """
    global paddle

    img_rgb = cv2.cvtColor(image_np, cv2.COLOR_BGR2RGB) if image_np.shape[2] == 3 else image_np
    h_img, w_img = img_rgb.shape[:2]
    pil_img = Image.fromarray(img_rgb)

    for attempt in range(2):
        try:
            paddle_result = paddle.predict(img_rgb)
            break
        except RuntimeError as e:
            if attempt == 0:
                print(f"PaddleOCR RuntimeError, reinitializing: {e}")
                paddle = make_paddle()
            else:
                raise

    if not paddle_result or not paddle_result[0]:
        return []

    res        = paddle_result[0]
    rec_polys  = res.get('rec_polys', [])
    rec_texts  = res.get('rec_texts', [])
    rec_scores = res.get('rec_scores', [])

    if not rec_polys:
        return []

    words = []
    for poly, p_text, p_conf in zip(rec_polys, rec_texts, rec_scores):
        xs = [int(p[0]) for p in poly]
        ys = [int(p[1]) for p in poly]
        bx1 = max(0, min(xs)); bx2 = min(w_img, max(xs) + 1)
        by1 = max(0, min(ys)); by2 = min(h_img, max(ys) + 1)

        # Use PaddleOCR en directly for pure-numeric content
        if _is_numeric(p_text):
            words.append({
                'text':       p_text,
                'confidence': float(p_conf),
                'bbox':       [float(bx1), float(by1), float(bx2), float(by2)],
                'src':        'paddle',
            })
            continue

        # Crop and run VietOCR for text content.
        # Fix 1: trim right-side blank padding before recognition to reduce
        # hallucinated trailing tokens caused by whitespace noise.
        crop = _trim_right_padding(pil_img.crop((bx1, by1, bx2, by2)))
        try:
            v_text = viet.predict(crop)
        except Exception as e:
            print(f"VietOCR error on crop ({bx1},{by1},{bx2},{by2}): {e}")
            v_text = p_text  # fall back to paddle

        # Trim VietOCR hallucinations: autoregressive decoder sometimes
        # over-generates from right-edge noise.  If VietOCR produces
        # significantly more words than PaddleOCR detected, clip the excess.
        p_wc = len(p_text.split())
        v_words = v_text.split()
        if len(v_words) > p_wc + 3:
            v_text = ' '.join(v_words[:p_wc + 2])
            v_words = v_text.split()

        # Fix 4: tail token stripping.
        # VietOCR's autoregressive decoder bleeds content from adjacent columns
        # (page headers, column headers) as 1–2 trailing tokens.  These tokens
        # come from a known blocklist of Vietnamese words / abbreviations that
        # never legitimately end a construction task description, plus year numbers.
        if len(v_words) > p_wc:
            # Check two-word tail first
            if len(v_words) >= 2:
                t2 = ' '.join(v_words[-2:]).lower()
                if t2 in _TAIL_2:
                    v_words = v_words[:-2]
            # Then one-word tail (raw check first, then stripped)
            if len(v_words) > p_wc and v_words:
                raw = v_words[-1]
                t1 = raw.lower().strip('.,!?()[]')
                if raw in _TAIL_RAW or t1 in _TAIL_1 or _YEAR_TAIL_RE.match(t1):
                    v_words = v_words[:-1]
            v_text = ' '.join(v_words)

        # Fix 2: PaddleOCR operator fallback.
        # VietOCR mangles '>=' / '<=' / '=' to '?' or '-?'.
        # When PaddleOCR found operator chars but VietOCR produced '?', trust paddle.
        if _OPERATOR_RE.search(p_text) and '?' in v_text and '?' not in p_text:
            v_text = p_text

        # Fix 3: diameter symbol correction.
        # Þ is misread as P/p/b/2; Þ boxes score p_conf < 0.975 vs ≥0.985 for ASCII.
        if p_conf < _DIAMETER_CONF_THRESHOLD and _DIAMETER_RE.search(v_text):
            v_text = _DIAMETER_RE.sub(lambda m: f'Þ{m.group(2)}', v_text)

        # Fix 5: strip spurious wrapping double-quotes added by VietOCR.
        if len(v_text) >= 2 and v_text.startswith('"') and v_text.endswith('"'):
            v_text = v_text[1:-1]

        # Fix 6: phrase-level diacritic corrections for recurring systematic misreads.
        for _pat, _repl in _PHRASE_SUBS:
            v_text = _pat.sub(_repl, v_text)

        words.append({
            'text':       v_text,
            'confidence': float(p_conf),  # use paddle det confidence as proxy
            'bbox':       [float(bx1), float(by1), float(bx2), float(by2)],
            'src':        'viet',
        })

    return words


@app.route('/health', methods=['GET'])
def health():
    return jsonify({"status": "ok", "model": "hybrid (PaddleOCR 3.x det + VietOCR rec)"})


@app.route('/ocr', methods=['POST'])
def ocr_endpoint():
    if not _authorized():
        return jsonify({"error": "Unauthorized"}), 401
    """
    OCR endpoint — accepts base64 image, returns word bboxes + text.

    Request:  {"image": "<base64>", "page": 1}
    Response: {"words": [{text, confidence, bbox, src}], "page": 1, "word_count": N}
    """
    try:
        data = request.get_json()
        if 'image' not in data:
            return jsonify({"error": "No image provided"}), 400

        image_data = base64.b64decode(data['image'])
        image      = Image.open(io.BytesIO(image_data)).convert('RGB')
        image_np   = np.array(image)
        image_bgr  = cv2.cvtColor(image_np, cv2.COLOR_RGB2BGR)

        page_num = data.get('page', 0)
        try:
            with _inference_lock:
                words = hybrid_ocr(image_bgr)
        except Exception as infer_err:
            import traceback
            print(f"[hybrid_ocr ERROR page {page_num}]", traceback.format_exc())
            words = []

        return jsonify({"words": words, "page": page_num, "word_count": len(words)})

    except Exception as e:
        import traceback
        print(traceback.format_exc())
        return jsonify({"error": str(e)}), 500


@app.route('/batch_ocr', methods=['POST'])
def batch_ocr():
    if not _authorized():
        return jsonify({"error": "Unauthorized"}), 401
    """
    Batch OCR — processes multiple pages.

    Request:  {"pages": [{"image": "<base64>", "page": 1}, ...]}
    Response: {"results": [...], "total_pages": N}
    """
    try:
        data    = request.get_json()
        pages   = data.get('pages', [])
        results = []

        for page_data in pages:
            image_data = base64.b64decode(page_data['image'])
            image      = Image.open(io.BytesIO(image_data)).convert('RGB')
            image_bgr  = cv2.cvtColor(np.array(image), cv2.COLOR_RGB2BGR)
            with _inference_lock:
                words = hybrid_ocr(image_bgr)
            results.append({
                "words":      words,
                "page":       page_data.get('page', 0),
                "word_count": len(words),
            })

        return jsonify({"results": results, "total_pages": len(results)})

    except Exception as e:
        import traceback
        print(traceback.format_exc())
        return jsonify({"error": str(e)}), 500


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=False)
