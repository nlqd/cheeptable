#!/usr/bin/env python3
"""Synthetic second document, never used for tuning: a scanned-looking Vietnamese price table with a
different layout, fonts and vocabulary than the real contract, so gains must generalise.
Writes synth.pdf (image-only, like a scan) and synth_golden.xlsx (same columns as golden.xlsx)."""
import random

import numpy as np
import openpyxl
from PIL import Image, ImageDraw, ImageFilter, ImageFont

rnd = random.Random(20261015)
FONTS = {
    "sans": ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
    "serif": ("/usr/share/fonts/truetype/freefont/FreeSerif.ttf", "/usr/share/fonts/truetype/freefont/FreeSerifBold.ttf"),
}
ITEMS = ["Dây cáp điện bọc nhựa PVC", "Ổ cắm điện đôi có nắp che", "Công tắc đèn một chiều", "Bóng đèn LED tuýp", "Máng đèn huỳnh quang đôi",
         "Ống luồn dây điện tròn", "Tủ điện âm tường", "Aptomat bảo vệ quá tải", "Quạt thông gió âm trần", "Máy bơm nước ly tâm",
         "Van cổng đồng nối ren", "Ống thép mạ kẽm nhúng nóng", "Cút nối nhựa PPR", "Băng keo cách điện", "Đầu cốt đồng ép",
         "Thang cáp mạ kẽm có nắp", "Bản lề cửa thép không gỉ", "Khóa cửa tay gạt inox", "Sơn chống thấm gốc xi măng", "Bột trét tường nội thất",
         "Gạch lát nền granite", "Tấm trần thạch cao chịu ẩm", "Kính cường lực trong suốt", "Cửa nhôm kính hệ Xingfa", "Lan can ban công sắt hộp",
         "Máng nước mái tôn lạnh", "Bình nước nóng năng lượng mặt trời", "Chậu rửa mặt sứ treo tường", "Vòi sen tăng áp", "Bồn cầu một khối",
         "Đèn báo thoát hiểm", "Đầu báo khói quang điện", "Bình chữa cháy bột ABC", "Camera quan sát ngoài trời", "Thiết bị lưu trữ hình ảnh",
         "Cột thu lôi phóng điện sớm", "Dây đồng trần tiếp địa", "Cọc tiếp địa mạ đồng", "Hộp nối dây chống nước", "Biến áp cách ly một pha"]
SIZES = ["", " D20", " D32", " 2x1,5mm2", " 3x4mm2", " 600x600mm", " loại 1", " dày 5mm", " 1,2m", " 18W", " 220V", " Ø60", " Þ90"]
UNITS = ["cái", "bộ", "m", "m2", "cuộn", "hộp", "kg", "tấm", "chiếc", "m3"]


def money(v):
    return "{:,}".format(int(v)).replace(",", ".")


def qty_text(q):
    return str(q).replace(".", ",") if q != int(q) else str(int(q))


def make_rows(n, start):
    rows = []
    for i in range(n):
        desc = rnd.choice(ITEMS) + rnd.choice(SIZES)
        qty = rnd.choice([round(rnd.uniform(0.2, 30), 2), rnd.randint(1, 400)])
        price = rnd.randint(8, 4200) * 1000 + rnd.choice([0, 0, 500, 250])
        rows.append((start + i, desc, rnd.choice(UNITS), qty, price, int(round(qty * price))))
    return rows


def render_page(rows, layout, page_no):
    W, H = 1191, 1685
    regular, bold = FONTS[layout["font"]]
    f, fb = ImageFont.truetype(regular, layout["size"]), ImageFont.truetype(bold, layout["size"])
    img = Image.new("L", (W, H), 255)
    d = ImageDraw.Draw(img)
    left, top, rh = 70, 120, layout["row_h"]
    xs = [left]
    for w in layout["cols"]:
        xs.append(xs[-1] + w)
    heads = layout["heads"]
    table = [heads] + [[str(r[0]), r[1], r[2], qty_text(r[3]), money(r[4]), money(r[5])] for r in rows]
    for ri, row in enumerate(table):
        y = top + ri * rh
        for ci, cell in enumerate(row):
            fnt = fb if ri == 0 else f
            tw = d.textlength(cell, font=fnt)
            if ri == 0 or ci in layout["center"]:
                x = xs[ci] + (xs[ci + 1] - xs[ci] - tw) / 2
            elif ci in layout["right"]:
                x = xs[ci + 1] - tw - 8
            else:
                x = xs[ci] + 8
            d.text((x, y + (rh - layout["size"]) / 2 - 2), cell, font=fnt, fill=15)
    bottom = top + len(table) * rh
    lw = layout["line"]
    for ri in range(len(table) + 1):
        d.line([(xs[0], top + ri * rh), (xs[-1], top + ri * rh)], fill=20, width=lw)
    for x in xs:
        d.line([(x, top), (x, bottom)], fill=20, width=lw)
    d.text((W / 2 - 20, H - 70), str(page_no), font=f, fill=40)
    img = img.rotate(rnd.uniform(-0.5, 0.5), resample=Image.BICUBIC, fillcolor=255)
    arr = np.asarray(img, dtype=np.float32) + np.random.RandomState(page_no).normal(0, 6, (H, W))
    img = Image.fromarray(np.clip(arr, 0, 255).astype("uint8")).filter(ImageFilter.GaussianBlur(0.6))
    return img


LAYOUT_A = dict(font="sans", size=21, row_h=40, line=2, cols=[60, 445, 80, 110, 150, 195], center=[0, 2], right=[3, 4, 5],
                heads=["STT", "Tên vật tư, thiết bị", "ĐVT", "Số lượng", "Đơn giá", "Thành tiền"])
LAYOUT_B = dict(font="serif", size=24, row_h=46, line=1, cols=[70, 430, 90, 120, 150, 180], center=[0, 2], right=[3, 4, 5],
                heads=["Stt", "Mô tả hàng hóa", "Đvt", "Khối lượng", "Đơn giá (đ)", "Thành tiền (đ)"])

if __name__ == "__main__":
    pages, golden, n = [], [], 1
    for p, layout in enumerate([LAYOUT_A, LAYOUT_A, LAYOUT_B, LAYOUT_B], 1):
        rows = make_rows(30, n)
        n += len(rows)
        golden += rows
        pages.append(render_page(rows, layout, p))
    pages[0].save("synth.pdf", save_all=True, append_images=pages[1:], resolution=144)
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(["Stt", "Mô tả công việc", "Đvt", "Khối lượng", "Đơn giá", "Thành tiền"])
    for r in golden:
        ws.append(list(r))
    wb.save("synth_golden.xlsx")
    pages[0].save("synth_p1_preview.png")
    print(len(golden), "rows,", len(pages), "pages")
