// 把截图识别（tesseract.js）需要的文件复制到 public/ocr，部署时跟网站一起发布。
// 不用外部 CDN：国内访问 jsdelivr 不稳定。升级 tesseract.js 后重新运行：node scripts/copy-ocr.mjs
import { cpSync, mkdirSync } from 'node:fs';

const out = 'public/ocr';
mkdirSync(`${out}/lang`, { recursive: true });
cpSync('node_modules/tesseract.js/dist/worker.min.js', `${out}/worker.min.js`);
// 只需要 LSTM 引擎：支持 SIMD 的浏览器用 simd 版，其他用普通版
for (const f of ['tesseract-core-simd-lstm.wasm.js', 'tesseract-core-lstm.wasm.js']) cpSync(`node_modules/tesseract.js-core/${f}`, `${out}/${f}`);
// 简体中文，LSTM 专用的精简模型（约 1.7MB）
cpSync('node_modules/@tesseract.js-data/chi_sim/4.0.0_best_int/chi_sim.traineddata.gz', `${out}/lang/chi_sim.traineddata.gz`);
console.log('copied OCR files to', out);
