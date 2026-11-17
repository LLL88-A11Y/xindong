// 聊天截图 → 文字。全部在浏览器里完成：图片不上传，也不花模型额度。
// 做法：先按颜色找出一个个气泡，再把每个气泡单独交给 tesseract.js（简体中文）识别。
// 整张图直接识别不行：头像会被认成字，右边的气泡会被版面分析漏掉。
// 谁说的：气泡贴着哪一边（左边留白小 = 对方，右边留白小 = 我）；很长的气泡两边都贴，就看同色的其他气泡。

// worker 里用 importScripts / fetch 加载这些文件，必须是完整网址（worker 是 blob 地址，相对路径会失效）
const BASE = new URL(`${import.meta.env.BASE_URL}ocr/`, location.href).href;

let workerPromise = null;
let onStatus = null;

const STATUS = {
  'loading tesseract core': '下载识别组件',
  'initializing tesseract': '准备中',
  'loading language traineddata': '下载中文字库',
  'initializing api': '准备中',
};

function getWorker() {
  if (!workerPromise) {
    workerPromise = import('tesseract.js')
      .then(async ({ createWorker }) => {
        const worker = await createWorker('chi_sim', 1, {
          workerPath: `${BASE}worker.min.js`,
          corePath: BASE,
          langPath: `${BASE}lang`,
          logger: (m) => {
            const label = STATUS[m.status];
            if (label) onStatus?.(`${label} ${Math.round((m.progress || 0) * 100)}%`);
          },
        });
        await worker.setParameters({ tessedit_pageseg_mode: '6' }); // 每个气泡是一整块文字
        return worker;
      })
      .catch((e) => { workerPromise = null; throw e; });
  }
  return workerPromise;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const near = (a, b, tol) => Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol && Math.abs(a[2] - b[2]) <= tol;
const lum = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];

/**
 * 在一张（缩小过的）图里找聊天气泡。纯函数，方便测试。
 * px：RGBA 像素；返回 [{ x0, y0, x1, y1, color }]，坐标是这张图的像素
 */
export function findBubbles(px, W, H) {
  const at = (x, y) => (y * W + x) * 4;
  const rgb = (i) => [px[i], px[i + 1], px[i + 2]];

  // 页面底色：左右边缘两列里最常见的颜色
  const votes = new Map();
  for (let y = Math.floor(H * 0.1); y < H * 0.9; y += 2) {
    for (const x of [1, W - 2]) {
      const c = rgb(at(x, y));
      const key = c.map((v) => v >> 3).join();
      const v = votes.get(key) ?? { n: 0, c };
      v.n++; votes.set(key, v);
    }
  }
  const bg = [...votes.values()].sort((a, b) => b.n - a.n)[0].c;

  // 和底色不同的像素连成片：气泡（底色 + 里面的字）是一片，头像、单个字是小片
  const seen = new Uint8Array(W * H);
  const isFg = (p) => !near(rgb(p * 4), bg, 9);
  const stack = new Int32Array(W * H);
  const found = [];
  for (let start = 0; start < W * H; start++) {
    if (seen[start] || !isFg(start)) continue;
    let top = 0; stack[top++] = start; seen[start] = 1;
    let x0 = W, y0 = H, x1 = 0, y1 = 0, n = 0;
    const hist = new Map();
    while (top) {
      const p = stack[--top];
      const x = p % W, y = (p - x) / W;
      n++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      const c = rgb(p * 4); const key = c.map((v) => v >> 3).join();
      const h = hist.get(key) ?? { n: 0, c }; h.n++; hist.set(key, h);
      for (const q of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, y > 0 ? p - W : -1, y < H - 1 ? p + W : -1]) {
        if (q >= 0 && !seen[q] && isFg(q)) { seen[q] = 1; stack[top++] = q; }
      }
    }
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    if (w < W * 0.08 || h < H * 0.018) continue;             // 单个字、小图标
    if (w > W * 0.9) continue;                                // 标题栏、输入栏这种通栏
    if (y1 < H * 0.05 || y0 > H * 0.95) continue;             // 状态栏
    if (y0 <= 0 || y1 >= H - 1) continue;                     // 被截图上下边缘切掉一半的气泡、头像：认不全，不如不要
    const square = Math.abs(w - h) < Math.max(w, h) * 0.25 && w < W * 0.16;
    if (square && (x0 < W * 0.1 || x1 > W * 0.9)) continue;   // 贴边的方块：头像
    const fill = [...hist.values()].sort((a, b) => b.n - a.n)[0];
    if (fill.n / n < 0.4) continue;                           // 颜色太杂：图片、表情包
    const cx = (x0 + x1) / 2;
    if (w < W * 0.4 && Math.abs(cx - W / 2) < W * 0.08) continue; // 居中的小块：时间、系统提示
    found.push({ x0, y0, x1, y1, color: fill.c });
  }
  return found;
}

/** 给每个气泡标上"我"或"对方"。纯函数。 */
export function assignSpeakers(bubbles, W) {
  const side = (b) => {
    const left = b.x0 / W, right = (W - 1 - b.x1) / W;
    if (Math.abs(left - right) < 0.08) return null; // 两边都贴（很长的消息），看同色的其他气泡
    return right < left ? '我' : '对方';
  };
  const groups = [];
  for (const b of bubbles) {
    let g = groups.find((x) => near(x.color, b.color, 24));
    if (!g) groups.push((g = { color: b.color, votes: { 我: 0, 对方: 0 } }));
    b.group = g;
    const s = side(b); if (s) g.votes[s]++;
  }
  return bubbles.map((b) => ({ ...b, who: side(b) ?? (b.group.votes.我 > b.group.votes.对方 ? '我' : '对方') }));
}

// 中文之间 tesseract 常插空格，去掉；英文单词之间的空格保留
const tidy = (s) => s.replace(/\s+/g, ' ').replace(/(?<=[^\x00-\x7f])\s+|\s+(?=[^\x00-\x7f])/g, '').trim();

async function loadCanvas(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    // 统一缩放到宽 1200：字高大约 30~40 像素，tesseract 最准
    const scale = clamp(1200 / img.naturalWidth, 0.5, 3);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d', { willReadFrequently: true }).drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// 把一个气泡裁出来：灰度；深底浅字就反色（tesseract 认浅底深字更准）
function crop(canvas, b, k, dark) {
  const inset = Math.round(4 * k);
  const x = b.x0 * k + inset, y = b.y0 * k + inset;
  const w = (b.x1 - b.x0 + 1) * k - inset * 2, h = (b.y1 - b.y0 + 1) * k - inset * 2;
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(w)); out.height = Math.max(1, Math.round(h));
  const ctx = out.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(canvas, x, y, w, h, 0, 0, out.width, out.height);
  const img = ctx.getImageData(0, 0, out.width, out.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    let v = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    if (dark) v = 255 - v;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

// 某个字的把握低于这个值，这一条就标成"可能认错了"。报告 32 的 44 条实测：4 条真有错字的最低把握是 0/0/0/26，
// 认对的里也有 0~29 的（单字被低估），只看最低把握分不干净；30 能抓全 4 处错字，误报从 10 条降到 5 条
const UNSURE = 30;

/** 返回 [{ who, text, unsure }]；text 为空表示这个气泡没认出字 */
export async function readChat(file, status) {
  onStatus = status;
  status?.('准备中…');
  const [canvas, worker] = await Promise.all([loadCanvas(file), getWorker()]);

  // 找气泡用缩小的图（快），识别用原图
  const small = document.createElement('canvas');
  const k = canvas.width / 400;
  small.width = 400; small.height = Math.round(canvas.height / k);
  const sctx = small.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(canvas, 0, 0, small.width, small.height);
  const px = sctx.getImageData(0, 0, small.width, small.height).data;
  const bubbles = assignSpeakers(findBubbles(px, small.width, small.height), small.width).sort((a, b) => a.y0 - b.y0);

  const rows = [];
  for (const [i, b] of bubbles.entries()) {
    status?.(`识别中 ${i + 1}/${bubbles.length}`);
    const { data } = await worker.recognize(crop(canvas, b, k, lum(b.color) < 128), {}, { blocks: true });
    const text = tidy(data.text || '');
    // 认不出字的气泡留一个空行占位，不打乱前后顺序；用户不补就自动不用
    if (!text || data.confidence < 45) { rows.push({ who: b.who, text: '', unsure: false, conf: 0 }); continue; } // 空行有提示文字，不标黄
    const words = (data.blocks ?? []).flatMap((bl) => bl.paragraphs.flatMap((pa) => pa.lines.flatMap((l) => l.words)));
    const confs = words.filter((w) => /[^\s，。！？、,.!?]/.test(w.text)).map((w) => w.confidence);
    const conf = confs.length ? Math.round(Math.min(...confs)) : Math.round(data.confidence);
    rows.push({ who: b.who, text, unsure: conf < UNSURE, conf });
  }
  return rows;
}
