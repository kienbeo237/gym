/**
 * Nén ảnh TRƯỚC khi tải lên, ngay trên trình duyệt.
 *
 * Ảnh chụp điện thoại thường 3–8MB, mà hạn mức là 2MB (FILE_RULES). Chỉ chặn
 * thì gần như không ai tải được ảnh nào; nên thu nhỏ về cạnh dài 1600px rồi mã
 * hoá lại — đủ nét để so tiến độ, thường còn 200–600KB.
 *
 * Mã hoá lại qua canvas cũng BỎ SẠCH EXIF, gồm cả toạ độ GPS nơi chụp — với
 * ảnh cơ thể của hội viên thì đó là điều nên có, không phải tác dụng phụ.
 *
 * Máy chủ vẫn là chốt chặn thật (đọc lại kích thước từ S3 ở bước xác nhận);
 * đây chỉ để người dùng không phải tự đi nén ảnh.
 */
const CANH_DAI = 1600;

export async function nenAnh(tep: File, toiDa: number): Promise<File> {
  const anh = await docAnh(tep);
  const tiLe = Math.min(1, CANH_DAI / Math.max(anh.width, anh.height));
  let rong = Math.round(anh.width * tiLe);
  let cao = Math.round(anh.height * tiLe);

  // Hạ dần chất lượng, rồi tới kích thước, cho tới khi vừa hạn mức.
  for (const chatLuong of [0.82, 0.72, 0.6, 0.6, 0.6]) {
    const blob = await maHoa(anh, rong, cao, chatLuong);
    if (blob.size <= toiDa) {
      const duoi = blob.type === 'image/webp' ? 'webp' : 'jpg';
      const ten = tep.name.replace(/\.[^.]+$/, '') + '.' + duoi;
      return new File([blob], ten, { type: blob.type });
    }
    if (chatLuong === 0.6) {
      rong = Math.round(rong * 0.8);
      cao = Math.round(cao * 0.8);
    }
  }
  throw new Error(`Không nén được ảnh xuống dưới ${Math.round(toiDa / 1_000_000)}MB — hãy chọn ảnh khác.`);
}

async function docAnh(tep: File): Promise<ImageBitmap | HTMLImageElement> {
  // createImageBitmap xoay đúng chiều theo EXIF; trình duyệt cũ thì dùng <img>.
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(tep, { imageOrientation: 'from-image' });
    } catch {
      /* rơi xuống cách dưới */
    }
  }
  const url = URL.createObjectURL(tep);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } catch {
    throw new Error('Không đọc được ảnh này. Hãy chọn ảnh JPG, PNG hoặc WebP.');
  } finally {
    URL.revokeObjectURL(url);
  }
}

function maHoa(anh: CanvasImageSource, rong: number, cao: number, chatLuong: number): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = rong;
  canvas.height = cao;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.reject(new Error('Trình duyệt không xử lý được ảnh'));
  ctx.drawImage(anh, 0, 0, rong, cao);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => {
        // Safari cũ không mã hoá được WebP và lặng lẽ trả PNG (rất nặng) —
        // khi đó dùng JPEG.
        if (b && b.type === 'image/webp') return resolve(b);
        canvas.toBlob((j) => (j ? resolve(j) : reject(new Error('Không nén được ảnh'))), 'image/jpeg', chatLuong);
      },
      'image/webp',
      chatLuong,
    );
  });
}
