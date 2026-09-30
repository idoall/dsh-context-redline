// 把 demo 打成「单文件独立版」：内联 CSS/JS。
// 用途：file:// 双击即可打开、可放进 GUI 预览、可 AirDrop 到手机 —— 完全不依赖本地服务。
// 用法：node demo/build-standalone.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const dir = new URL('./', import.meta.url);
const rd = (f) => readFileSync(new URL(f, dir), 'utf8');

let html = rd('redline-panel.html');
const css = rd('demo.css');
const js = rd('demo.js');

/**
 * 打包指纹 = demo.css + demo.js 的 sha256 前 7 位。
 * 为什么要它：单文件版是**生成物**，改完 css/js 忘了重打包 → 用户看到的还是旧界面，
 * 而且从外观上看不出来（"_v=4/v=5" 只对多文件版生效，单文件版内联、没有查询串）。
 * 把指纹写进页头 + 让 check-static.mjs 比对 → "忘了重打包"从静默变红。
 * 用内容哈希而不用时间戳：这样重复打包是**幂等**的（同一份输入 → 同一份输出）。
 */
const fp = createHash('sha256').update(css + '\u0000' + js).digest('hex').slice(0, 7);

// 用正则替换，这样 HTML 里把 ?v=N 升到 v=3、v=4 都不用改本脚本
html = html.replace(/<link rel="stylesheet" href="\.\/demo\.css[^"]*"\s*\/?>/, `<style>\n${css}\n</style>`);
html = html.replace(/<script src="\.\/demo\.js[^"]*"><\/script>/, `<script>\n${js}\n</script>`);

// 页头那颗「交互原型 v1」标签里嵌上指纹（找不到就报错，别静默什么都不做）
const BRAND = /<span class="tag">交互原型 v1<\/span>/;
if (!BRAND.test(html)) {
  console.error('没找到页头的 <span class="tag">交互原型 v1</span>，无法写入打包指纹');
  process.exit(1);
}
html = html.replace(BRAND,
  `<span class="tag" title="单文件版打包指纹（demo.css + demo.js 的 sha256 前 7 位）：拿它跟我核对是不是最新版">交互原型 v1 · 单文件版 ${fp}</span>`);

// 只查「外链标签」是否还在（JS 注释里出现 demo.js 是正常的，别误判 —— 这里踩过一次）
if (html.includes('href="./demo.css') || html.includes('src="./demo.js')) {
  console.error('内联失败：仍有外链标签');
  process.exit(1);
}

const out = new URL('redline-panel.standalone.html', dir);
writeFileSync(out, html);
console.log(`已生成 ${out.pathname}（${html.length} bytes，无外链）`);
console.log(`打包指纹：${fp}  ← 页头标签里也会显示"单文件版 ${fp}"`);
