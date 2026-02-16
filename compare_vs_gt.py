#!/usr/bin/env python3
"""Compare extracted OCR table (from new.html) against golden.xlsx ground truth."""

import json
import re
import openpyxl

EXTRACTED_JSON = '/tmp/extracted_rows.json'
GT_PATH        = 'golden.xlsx'


# ── Number parsing ─────────────────────────────────────────────────────────────

def parse_vn(s):
    """Parse Vietnamese number: dots=thousands, comma=decimal. Returns float or None."""
    try:
        s = str(s).strip().replace(' ', '')
        s = re.sub(r'[()[\]%]', '', s)
        if not re.search(r'\d', s):
            return None
        if ',' in s and '.' not in s:
            # comma is decimal: "4,610" → 4.610
            s = s.replace(',', '.')
        elif ',' in s and '.' in s:
            # both: dots=thousands, comma=decimal: "1.234,56" → 1234.56
            s = s.replace('.', '').replace(',', '.')
        elif s.count('.') > 1:
            # multiple dots = thousands: "1.801.750" → 1801750
            s = s.replace('.', '')
        elif s.count('.') == 1:
            # single dot: Vietnamese uses dot as thousands separator for X.YYY
            # e.g. "300.000" → 300000, "583.275" → 583275
            # Heuristic: if exactly 3 digits after the dot, treat as thousands separator
            if re.match(r'^\d+\.\d{3}$', s):
                s = s.replace('.', '')
            # else keep as-is (genuine decimal like "0.7" is unusual in Vietnamese docs)
        return float(s)
    except (ValueError, AttributeError):
        return None


# ── GT loading ─────────────────────────────────────────────────────────────────

def load_gt():
    wb  = openpyxl.load_workbook(GT_PATH, data_only=True)
    ws  = wb.active
    rows = []
    for row in ws.iter_rows(values_only=True):
        stt, desc, unit, qty, price, total = row
        if not isinstance(stt, (int, float)):
            continue
        rows.append({
            'stt':   int(stt),
            'desc':  str(desc or '').strip(),
            'unit':  str(unit or '').strip(),
            'qty':   float(qty)   if qty   is not None else None,
            'price': float(price) if price is not None else None,
            'total': float(total) if total is not None else None,
        })
    return rows


# ── OCR row loading ─────────────────────────────────────────────────────────────

def cell_val(c):
    """Get text value from a cell (either string or {value: ...} object)."""
    if isinstance(c, dict):
        return str(c.get('value') or '').strip()
    return str(c or '').strip()


def load_ocr_rows(path):
    """Load extracted rows JSON, return (by_stt dict, all_rows list).

    by_stt: {stt_int: [c0, c1, c2, c3, c4, c5]}
    all_rows: every row as a list of cell strings (including rows with no STT)
    """
    data = json.load(open(path))
    by_stt    = {}
    all_rows  = []

    for row in data:
        cells = row.get('cells', [])
        if not cells:
            continue

        col_texts = [cell_val(c) for c in cells]
        while len(col_texts) < 6:
            col_texts.append('')

        all_rows.append(col_texts[:6])

        stt_text  = col_texts[0]
        desc_text = col_texts[1]

        # Try to find STT in col 0
        m = re.match(r'^(\d+)$', stt_text)

        # Fallback: STT merged into description (e.g. "10Van chuyén...", "17 [Đúc...")
        # Only if: 1-3 digits immediately followed by a letter or bracket (not "1 270 /Ống...")
        if not m and desc_text:
            if not re.match(r'^\d+\.\s*[A-ZĐÁÀẢÃẠ]', desc_text):  # skip "1.ĐƯỜNG..." sections
                m = re.match(
                    r'^(\d{1,3})\s*(?=[A-Za-zĐÁÀẢÃẠÂĂắặẩẫậéèẻẽẹêếềểễệíìỉĩịóòỏõọôốồổỗộơớờởỡợúùủũụưứừửữựýỳỷỹỵđ\[\(])',
                    desc_text)

        if not m:
            continue

        # Filter repeated header rows: "(1)"/"(2)"/"(3)" pattern in description
        if re.match(r'^\s*\(\d+\)', desc_text):
            continue

        stt = int(m.group(1))

        if stt in by_stt:
            prev = by_stt[stt]
            if col_texts[1]:
                prev[1] = (prev[1] + ' ' + col_texts[1]).strip()
            for i in range(2, 6):
                if col_texts[i] and not prev[i]:
                    prev[i] = col_texts[i]
        else:
            by_stt[stt] = col_texts[:6]

    return by_stt, all_rows


# ── Comparison ─────────────────────────────────────────────────────────────────

def parse_vn_candidates(s):
    """Return all sensible numeric interpretations of s.

    For the ambiguous "X,YYY" pattern (X > 0, exactly 3 digits after comma, no dot)
    the document mixes uses: dot-as-thousands OCR'd as comma ("4.610"→"4,610"=4610)
    AND genuine decimal commas ("3,883"=3.883).  We cannot tell which convention a
    given cell uses without arithmetic context, so we offer BOTH candidates and let
    num_match accept whichever is within tolerance of the GT value.
    """
    s = str(s).strip().replace(' ', '')
    s = re.sub(r'[()[\]%]', '', s)
    if not re.search(r'\d', s):
        return []
    candidates = []
    v_standard = parse_vn(s)
    if v_standard is not None:
        candidates.append(v_standard)
    # Extra candidate: comma-as-thousands for "X,YYY" pattern where X > 0
    m = re.match(r'^(\d+),(\d{3})$', s)
    if m and int(m.group(1)) > 0:
        v_thou = float(m.group(1) + m.group(2))
        if v_thou not in candidates:
            candidates.append(v_thou)
    return candidates


def num_match(ocr_text, gt_val, tol=0.005):
    """True if ANY sensible parse of ocr_text is within tol% of gt_val."""
    if gt_val is None:
        return True
    if not ocr_text:
        return False
    candidates = parse_vn_candidates(ocr_text)
    if not candidates:
        return False
    return any(abs(v - gt_val) / max(abs(gt_val), 1) <= tol for v in candidates)


def word_overlap(ocr_desc, gt_desc):
    """Fraction of GT words found (case-insensitive) in OCR description."""
    gt_words = set(re.findall(r'\w+', gt_desc.lower()))
    if not gt_words:
        return 1.0
    ocr_words = set(re.findall(r'\w+', ocr_desc.lower()))
    return len(gt_words & ocr_words) / len(gt_words)


def word_error_rate(ocr_text, gt_text):
    """Standard WER: Levenshtein edit distance on word sequences / len(GT words).

    Returns (wer_float, n_ref_words).
    wer=0.0 means perfect; wer=1.0 means every word wrong; can exceed 1.0 if
    OCR inserts many extra words.
    """
    ref = re.findall(r'\S+', gt_text.lower())
    hyp = re.findall(r'\S+', ocr_text.lower())
    n = len(ref)
    if n == 0:
        return 0.0, 0
    # DP edit distance on word sequences
    d = list(range(len(hyp) + 1))
    for r_word in ref:
        prev = d[:]
        d[0] = prev[0] + 1
        for j, h_word in enumerate(hyp, 1):
            d[j] = min(prev[j] + 1,          # deletion
                       d[j - 1] + 1,          # insertion
                       prev[j - 1] + (0 if r_word == h_word else 1))  # sub
    return d[len(hyp)] / n, n


def extract_embedded_stt(desc_text, max_stt):
    """Pull a leading STT number out of a description cell.

    Returns (valid_stt, raw_stt):
      valid_stt: int if 1-3 digits and ≤ max_stt, else None (safe for direct STT use)
      raw_stt:   int of ANY extracted leading number (even 4+ digits), None if absent
                 Used for suffix-based digit-fusion recovery: "7102" → raw_stt=7102
    """
    if not desc_text:
        return None, None
    # Skip section headers like "1.ĐƯỜNG NGUYỄN..." or "3. ĐƯỜNG TRƯƠNG..."
    if re.match(r'^\d+\.\s', desc_text):
        return None, None
    # Match any leading digit sequence followed by non-digit non-space
    m_raw = re.match(r'^(\d+)\s*(?=[^\d\s])', desc_text)
    if not m_raw:
        return None, None
    raw_stt = int(m_raw.group(1))
    # Valid embedded STT: exactly 1-3 digits AND within document range
    valid_stt = raw_stt if len(m_raw.group(1)) <= 3 and raw_stt <= max_stt else None
    return valid_stt, raw_stt


def build_price_total_index(all_rows, max_stt):
    """Index all rows by (price_parsed, total_parsed) for fallback matching.

    Each entry stores embedded_stt (validated ≤ max_stt) and raw_stt (unvalidated,
    for digit-fusion suffix matching).
    """
    idx = {}
    for row in all_rows:
        p = parse_vn(row[4])
        t = parse_vn(row[5])
        if p and t and p > 0 and t > 0:
            valid_stt, raw_stt = extract_embedded_stt(row[1], max_stt)
            # Track whether col[0] itself is a numeric STT (row already "claimed" directly)
            c0 = row[0].strip()
            direct_stt = int(c0) if re.match(r'^\d+$', c0) else None
            key = (p, t)
            idx.setdefault(key, []).append({
                'row': row,
                'embedded_stt': valid_stt,
                'raw_stt': raw_stt,
                'direct_stt': direct_stt,
            })
    return idx


def main():
    print('Loading ground truth...')
    gt_rows = load_gt()
    print(f'  {len(gt_rows)} numbered data rows in golden.xlsx')

    print('Loading OCR extraction...')
    ocr_by_stt, all_rows = load_ocr_rows(EXTRACTED_JSON)
    print(f'  {len(ocr_by_stt)} STT-matched rows, {len(all_rows)} total OCR rows')

    # Build a (price, total) index for fallback matching of rows with missing STT
    max_stt  = max(r['stt'] for r in gt_rows) if gt_rows else 9999
    pt_index = build_price_total_index(all_rows, max_stt)

    # ── Per-row comparison ─────────────────────────────────────────────────────
    total        = len(gt_rows)
    found_stt    = 0
    found_pt     = 0  # found via price+total fallback
    qty_ok_n     = price_ok_n = total_ok_n = 0
    word_ovl_sum = 0.0
    missing_stts = []
    mismatches   = []
    all_num_ok   = 0
    # Text accuracy
    wer_sum      = 0.0
    wer_ref_words= 0
    exact_match  = 0
    unit_exact   = 0

    for gt in gt_rows:
        stt = gt['stt']
        ocr = None

        if stt in ocr_by_stt:
            ocr = ocr_by_stt[stt]
            found_stt += 1
        elif gt['price'] and gt['total']:
            # Fallback: try to match by (price, total) pair
            key = (gt['price'], gt['total'])
            candidates = pt_index.get(key, [])
            if not candidates:
                missing_stts.append(stt)
                continue
            elif len(candidates) == 1:
                ocr = candidates[0]['row']
                found_pt += 1
                pt_index[key] = []
            else:
                # Deprioritize rows already directly matched via col[0]
                # (e.g. c0='326' → that row belongs to STT 326, not a fallback candidate)
                non_direct = [c for c in candidates if c['direct_stt'] is None]
                pool = non_direct if non_direct else candidates

                # Step 1: exact embedded STT match in pool
                by_stt = [c for c in pool if c['embedded_stt'] == stt]
                if len(by_stt) == 1:
                    ocr = by_stt[0]['row']
                    pt_index[key] = [c for c in candidates if c is not by_stt[0]]
                    found_pt += 1
                else:
                    # Step 2: suffix-based raw_stt match
                    # Handles OCR digit-fusion: "7102" ends in "102" → STT 102
                    stt_suffix = str(stt)
                    by_suffix = [c for c in pool
                                 if c['raw_stt'] is not None
                                 and c['raw_stt'] != stt
                                 and str(c['raw_stt']).endswith(stt_suffix)]
                    if len(by_suffix) == 1:
                        ocr = by_suffix[0]['row']
                        pt_index[key] = [c for c in candidates if c is not by_suffix[0]]
                        found_pt += 1
                    else:
                        # Step 3: prefer truly unclaimed candidates (no digit prefix at all)
                        # "IKhuỷu..." has raw_stt=None → no STT claim; "265|Khuỷu" has raw_stt=265
                        unclaimed = [c for c in pool
                                     if c['embedded_stt'] is None and c['raw_stt'] is None]
                        if len(unclaimed) == 1:
                            ocr = unclaimed[0]['row']
                            pt_index[key] = [c for c in candidates if c is not unclaimed[0]]
                            found_pt += 1
                        else:
                            # Step 4: description similarity as last resort
                            gt_desc = gt['desc']
                            if gt_desc:
                                scored = [(word_overlap(c['row'][1], gt_desc), c)
                                          for c in pool]
                                scored.sort(key=lambda x: -x[0])
                                if len(scored) >= 2 and scored[0][0] > scored[1][0] + 0.1:
                                    best_c = scored[0][1]
                                    ocr = best_c['row']
                                    pt_index[key] = [c for c in candidates if c is not best_c]
                                    found_pt += 1
                                else:
                                    missing_stts.append(stt)
                                    continue
                            else:
                                missing_stts.append(stt)
                                continue
        else:
            missing_stts.append(stt)
            continue

        qty_ok   = num_match(ocr[3], gt['qty'])
        price_ok = num_match(ocr[4], gt['price'])
        tot_ok   = num_match(ocr[5], gt['total'])

        if qty_ok:   qty_ok_n   += 1
        if price_ok: price_ok_n += 1
        if tot_ok:   total_ok_n += 1
        if qty_ok and price_ok and tot_ok: all_num_ok += 1

        word_ovl_sum += word_overlap(ocr[1], gt['desc'])

        wer, nw = word_error_rate(ocr[1], gt['desc'])
        wer_sum       += wer * nw   # weight by ref length for macro avg
        wer_ref_words += nw
        if ocr[1].strip() == gt['desc'].strip():
            exact_match += 1
        if ocr[2].strip() == gt['unit'].strip():
            unit_exact += 1

        if not (qty_ok and price_ok and tot_ok):
            mismatches.append({
                'stt': stt, 'gt': gt, 'ocr': ocr,
                'qty_ok': qty_ok, 'price_ok': price_ok, 'total_ok': tot_ok,
            })

    # ── Report ─────────────────────────────────────────────────────────────────
    W = 60
    pct = lambda n, d: f'{n/d*100:.1f}%' if d else 'N/A'

    print(f'\n{"="*W}')
    print(f'ACCURACY REPORT vs golden.xlsx  ({total} GT rows)')
    print(f'{"="*W}')
    matched_total = found_stt + found_pt
    print(f'STT rows found:     {found_stt}/{total} ({pct(found_stt, total)})')
    print(f'  + fallback match: {found_pt} (by price+total)')
    print(f'  Total matched:    {matched_total}/{total} ({pct(matched_total, total)})')

    if missing_stts:
        shown = missing_stts[:30]
        suffix = f' ... +{len(missing_stts)-30} more' if len(missing_stts) > 30 else ''
        print(f'  Missing:          {shown}{suffix}')

    print()
    denom = matched_total or 1
    print(f'Khối lượng match:   {qty_ok_n}/{denom} ({pct(qty_ok_n, denom)})')
    print(f'Đơn giá match:      {price_ok_n}/{denom} ({pct(price_ok_n, denom)})')
    print(f'Thành tiền match:   {total_ok_n}/{denom} ({pct(total_ok_n, denom)})')
    print()
    print(f'All 3 numbers OK:   {all_num_ok}/{denom} ({pct(all_num_ok, denom)})')
    print()
    avg_wer = wer_sum / wer_ref_words * 100 if wer_ref_words else 0
    print(f'--- Text accuracy (description column) ---')
    print(f'Word accuracy (1-WER): {100-avg_wer:.1f}%  (WER={avg_wer:.1f}%)')
    print(f'Exact match:           {exact_match}/{denom} ({pct(exact_match, denom)})')
    print(f'Unit exact match:      {unit_exact}/{denom} ({pct(unit_exact, denom)})')

    # ── First 30 mismatches ────────────────────────────────────────────────────
    if mismatches:
        print(f'\n--- First {min(30, len(mismatches))} numeric mismatches ---')
        for m in mismatches[:30]:
            stt  = m['stt']
            gt   = m['gt']
            ocr  = m['ocr']
            flags = (f"qty={'✓' if m['qty_ok'] else '✗'} "
                     f"price={'✓' if m['price_ok'] else '✗'} "
                     f"total={'✓' if m['total_ok'] else '✗'}")
            print(f'  STT {stt:3d}: {flags}')
            if not m['qty_ok']:
                print(f'           qty  GT={gt["qty"]}  OCR="{ocr[3]}" (parsed={parse_vn(ocr[3])})')
            if not m['price_ok']:
                print(f'           price GT={gt["price"]}  OCR="{ocr[4]}" (parsed={parse_vn(ocr[4])})')
            if not m['total_ok']:
                print(f'           total GT={gt["total"]}  OCR="{ocr[5]}" (parsed={parse_vn(ocr[5])})')
    else:
        print('No numeric mismatches!')

    print(f'\n{"="*W}')


if __name__ == '__main__':
    main()
