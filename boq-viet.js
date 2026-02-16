// boq-viet.js — Vietnamese text processing: diacritics, dictionary, VPS API
'use strict';

// ── Vietnamese Diacritic Restoration ──
function restoreVietnameseDiacritics(text) {
  if (!text || text.length === 0) return text;

  // Common OCR corruption patterns for Vietnamese
  const replacements = {
    // Đ/D confusion
    'Dao ': 'Đào ', 'dao ': 'đào ',
    'Dat ': 'Đất ', 'dat ': 'đất ',
    'Den ': 'Đến ', 'den ': 'đến ',
    'Dap ': 'Đắp ', 'dap ': 'đắp ',
    'Dam ': 'Đầm ', 'dam ': 'đầm ',
    'Duong': 'Đường', 'duong': 'đường',
    'Doi ': 'Đổi ', 'doi ': 'đổi ',
    'Don ': 'Đơn ', 'don ': 'đơn ',
    'Do ': 'Đổ ', 'do ': 'đổ ',
    'Dvt': 'Đvt', 'dvt': 'đvt',
    'Dv ': 'Đvt ',

    // Common construction terms
    'phui': 'phụi', 'Phui': 'Phụi',
    'muong': 'mương', 'Muong': 'Mương',
    'ong ': 'ống ', 'Ong ': 'Ống ',
    'bang ': 'bằng ', 'Bang ': 'Bằng ',
    'may ': 'máy ', 'May ': 'Máy ',
    'thu ': 'thủ ', 'Thu ': 'Thủ ',
    'cong ': 'công ', 'Cong ': 'Công ',
    'cap ': 'cấp ', 'Cap ': 'Cấp ',
    'nen ': 'nền ', 'Nen ': 'Nền ',
    'cat ': 'cát ', 'Cat ': 'Cát ',
    'chat': 'chặt', 'Chat': 'Chặt',
    'be ': 'bê ', 'Be ': 'Bê ',
    'tong': 'tông', 'Tong': 'Tông',
    'mang': 'măng', 'Mang': 'Măng',
    'gach': 'gạch', 'Gach': 'Gạch',
    'vua': 'vữa', 'Vua': 'Vữa',
    'da ': 'đá ', 'Da ': 'Đá ',
    'soi': 'sỏi', 'Soi': 'Sỏi',
    'Van ': 'Vận ', 'van ': 'vận ',
    'chuyen': 'chuyển', 'Chuyen': 'Chuyển',
    'truong': 'trường', 'Truong': 'Trường',
    'lap ': 'lắp ', 'Lap ': 'Lắp ',
    'nuoc': 'nước', 'Nuoc': 'Nước',
    'khuy': 'khuỷu', 'Khuy': 'Khuỷu',
    'noi': 'nối', 'Noi': 'Nối',
    'gia ': 'giá ', 'Gia ': 'Giá ',
    'tien': 'tiền', 'Tien': 'Tiền',
    'luong': 'lượng', 'Luong': 'Lượng',
    'khoi': 'khối', 'Khoi': 'Khối',

    // Pipe symbol (diameter)
    'ploo': 'Þ', 'PIOO': 'Þ', 'P100': 'Þ100',
    'BISO': 'Þ150', 'Ed0': 'E40',
  };

  let result = text;
  for (const [wrong, correct] of Object.entries(replacements)) {
    // Use word boundary aware replacement
    const regex = new RegExp(wrong.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    result = result.replace(regex, correct);
  }

  return result;
}

// ── Vietnamese Dictionary & Spell Correction ──
const DEFAULT_VIETNAMESE_DICT = `
và các của có trong không được này để là cho với một khi như đã từ về sau theo
tại nên đến nếu thì sẽ bị vì hay nhưng lại chỉ còn vào ra ngoài trên dưới giữa
bên cạnh gần xa đây đó những người thời gian năm tháng ngày tuần kỳ hàng
cũng đều phải nữa thêm khác cùng nhau mình ta anh em ông bà chị
số lần lượt loại hình dạng màu sắc chất liệu vật chất liệu phẩm
điểm yếu điều khoản quan trọng tố chính phụ thêm bớt tăng giảm
đào phá phui mương ống bằng thủ công máy đất cấp đấp cát đầm chặt nền nén ép
bê tông xi măng vữa gạch đá sỏi kết cấu mặt đường nhựa lớp ván khuôn đổ phụ tùng thép
lắp đặt nước van khuỷu manchon bù nối khóa công việc khối lượng đơn giá thành tiền tổng
mô tả đơn vị tính mét vuông khối kilogram tấn trăm ngàn triệu tỷ đồng viên chiếc cái
tháo dỡ xây dựng cải tạo thay thế sửa chữa gia cố trải rải rót chuyển vận đổ bơm
biểu giá hợp đồng gói thầu dự án thi công vật tư thiết bị nhân cộng phần mục tiểu
xúc đấp đắp lèn lắp ghép ráp cốt pha thép trát tô trét quét sơn ốp lát dán
tuyến đoạn trạm trung tâm khu vực địa phương phường quận huyện tỉnh thành phố
điện chiếu sáng cấp điện hạ thế trung thế cao thế động lực điện dân dụng
điện lực điện năng điện công suất điện áp điện trở dây dẫn cáp điện đường dây
theo tính toán kế hoạch thi thể hiện thực hiện hoàn thành kết quả
cao thấp rộng hẹp dài ngắn sâu nông dày mỏng lớn nhỏ to nhỏ
tốt xấu đẹp tệ nhanh chậm mạnh yếu mới cũ mất còn đủ thiếu đầy
đúng sai chuẩn chính xác gần đúng khoảng chừng ước tính dự kiến
trước sau trái phải giữa bên trong ngoài đông tây nam bắc
một hai ba bốn năm sáu bảy tám chín mười mười một mười hai mười lăm hai mươi
ba mươi bốn mươi năm mươi sáu mươi bảy mươi tám mươi chín mươi trăm nghìn
centimet milimét kilomét tấn lít vuông khối mét
phá bỏ dỡ bỏ phá hủy khoan khoét cắt xén bẻ gãy đập vỡ
xây nề lên tường vách trần nền móng cột dầm sàn mái
cửa cổng lan can tay vịn bậc thang bậc cấp nấc thềm
điện nước thoát cống rãnh mương kênh hố giếng bể bồn
ren ống thẳng ống cong ống nối ống tê ống chữ ống chữ nối tê
khớp nối đầu nối bích mặt bích ống góc ống giảm đầu giảm co
van khóa van bi van bướm van cầu van công van một van chiều van chặn
đồng hồ đồng hồ đo đồng hồ nước đồng hồ điện công tơ điện
sơn nước sơn dầu sơn véc véc ni keo dán keo chà keo trộn
cát vàng cát trắng cát xây cát đổ đá dăm đá mi đá hộc sỏi rải
thép tròn thép hình thép chữ thép góc thép ray thép chữ thép vuông
gạch đỏ gạch ống gạch block gạch không nung đá ốp đá lát
bảng kê giá vật liệu xây dựng dự án nhà ở cao tầng địa điểm
tên đơn vị số lượng đvt tấn viên xi măng sắt gạch đồng tâm hòa phát
`.trim().split(/\s+/);

// Load custom words from localStorage
function loadCustomWords() {
  try {
    const stored = localStorage.getItem('vietocr_custom_dict');
    return stored ? JSON.parse(stored) : [];
  } catch (e) {
    console.error('Failed to load custom dictionary:', e);
    return [];
  }
}

// Save custom words to localStorage
function saveCustomWords(words) {
  try {
    localStorage.setItem('vietocr_custom_dict', JSON.stringify(words));
  } catch (e) {
    console.error('Failed to save custom dictionary:', e);
  }
}

// Build combined dictionary (default + custom)
function buildDictionary() {
  const customWords = loadCustomWords();
  const allWords = [...DEFAULT_VIETNAMESE_DICT, ...customWords];
  return new Set(allWords.map(w => w.toLowerCase()));
}

// Initialize dictionary
let VIETNAMESE_DICT = buildDictionary();

// Update UI with custom word count
function updateCustomWordsUI() {
  const customWords = loadCustomWords();
  document.getElementById('customCount').textContent = customWords.length;
  document.getElementById('customWordsList').textContent =
    customWords.length > 0 ? customWords.join(', ') : 'none';
}

// Add custom word
function addCustomWord() {
  const input = document.getElementById('customWord');
  const word = input.value.trim().toLowerCase();

  if (!word) {
    alert('Please enter a word');
    return;
  }

  const customWords = loadCustomWords();

  // Check if already exists
  if (customWords.includes(word) || DEFAULT_VIETNAMESE_DICT.includes(word)) {
    alert('Word already in dictionary');
    input.value = '';
    return;
  }

  // Add word
  customWords.push(word);
  saveCustomWords(customWords);

  // Rebuild dictionary
  VIETNAMESE_DICT = buildDictionary();

  // Update UI
  updateCustomWordsUI();
  input.value = '';

  log(`Added custom word: ${word}`, 'ok');
}

// Clear all custom words
function clearCustomWords() {
  if (!confirm('Clear all custom words? This cannot be undone.')) {
    return;
  }

  saveCustomWords([]);
  VIETNAMESE_DICT = buildDictionary();
  updateCustomWordsUI();
  log('Custom dictionary cleared', 'warn');
}

// Export custom dictionary
function exportCustomDict() {
  const customWords = loadCustomWords();
  const json = JSON.stringify(customWords, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'vietocr-custom-dictionary.json';
  a.click();
  URL.revokeObjectURL(url);
  log('Custom dictionary exported', 'ok');
}

// Import custom dictionary
function importCustomDict() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const imported = JSON.parse(event.target.result);
        if (!Array.isArray(imported)) {
          alert('Invalid format: expected array of words');
          return;
        }

        // SECURITY FIX #1: Sanitize imported words to prevent XSS
        const sanitized = imported.filter(word => {
          // Only allow Vietnamese letters, numbers, spaces, and hyphens, max 50 chars
          if (typeof word !== 'string' || word.length === 0 || word.length > 50) {
            return false;
          }
          // Vietnamese alphanumeric + common punctuation only
          return /^[\wàáảãạâấầẩẫậăắằẳẵặèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵđÀÁẢÃẠÂẤẦẨẪẬĂẮẰẲẴẶÈÉẺẼẸÊẾỀỂỄỆÌÍỈĨỊÒÓỎÕỌÔỐỒỔỖỘƠỚỜỞỠỢÙÚỦŨỤƯỨỪỬỮỰỲÝỶỸỴĐ\s\-\.]+$/.test(word);
        });

        const customWords = loadCustomWords();
        const merged = [...new Set([...customWords, ...sanitized])];

        saveCustomWords(merged);
        VIETNAMESE_DICT = buildDictionary();
        updateCustomWordsUI();

        const rejected = imported.length - sanitized.length;
        if (rejected > 0) {
          log(`Imported ${sanitized.length} words (${rejected} rejected for safety)`, 'warn');
        } else {
          log(`Imported ${sanitized.length} words (${merged.length - customWords.length} new)`, 'ok');
        }
      } catch (err) {
        alert('Failed to import: ' + err.message);
      }
    };
    reader.readAsText(file);
  };
  input.click();
}

function levenshteinDist(a, b) {
  // SECURITY FIX #3: Prevent DoS with unbounded strings (O(n²) memory/CPU)
  const MAX_LENGTH = 100;
  if (a.length > MAX_LENGTH || b.length > MAX_LENGTH) {
    return 999; // Return high distance for overly long strings
  }

  const m = [], al = a.length, bl = b.length;
  for (let i = 0; i <= bl; i++) m[i] = [i];
  for (let j = 0; j <= al; j++) m[0][j] = j;
  for (let i = 1; i <= bl; i++) {
    for (let j = 1; j <= al; j++) {
      m[i][j] = b[i-1] === a[j-1] ? m[i-1][j-1] :
                Math.min(m[i-1][j-1] + 1, m[i][j-1] + 1, m[i-1][j] + 1);
    }
  }
  return m[bl][al];
}

function removeDiacritics(str) {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');
}

// ── VPS Diacritic Restoration API ──
function loadDiacriticCache() {
  try {
    const stored = localStorage.getItem('viet_diacritic_cache');
    return stored ? JSON.parse(stored) : {};
  } catch (e) {
    console.error('Failed to load diacritic cache:', e);
    return {};
  }
}

function saveDiacriticCache() {
  try {
    localStorage.setItem('viet_diacritic_cache', JSON.stringify(diacriticCache));
  } catch (e) {
    // FIX Bug #6: Handle localStorage quota errors gracefully
    if (e.name === 'QuotaExceededError') {
      console.warn('Cache quota exceeded, clearing old entries');
      const entries = Object.entries(diacriticCache);
      diacriticCache = Object.fromEntries(entries.slice(-500)); // Keep newest 500
      try {
        localStorage.setItem('viet_diacritic_cache', JSON.stringify(diacriticCache));
        console.log('Cache trimmed and saved successfully');
      } catch (e2) {
        console.error('Cache still too large, running without persistence');
      }
    } else {
      console.error('Failed to save diacritic cache:', e);
    }
  }
}

async function correctVietnameseText(text) {
  return text;
}

// Helper: Convert string value to cell metadata object
async function createCellMetadata(value, avgOcrConfidence, colIndex) {
  if (!value || value === '') {
    return {
      value: '',
      original: '',
      confidence: 0,
      source: 'empty',
      correctedBy: null,
      type: classifyCellType('', colIndex),
      edited: false
    };
  }

  const original = value;

  // DISABLED: Use original OCR without corrections
  // User reported OCR is already correct (e.g., "CHỦ NGHĨA VIỆT NAM")
  // Auto-correction was making it worse
  return {
    value: original,
    original: original,
    confidence: avgOcrConfidence,
    source: 'ocr',
    correctedBy: null,
    type: classifyCellType(original, colIndex),
    edited: false
  };
}

