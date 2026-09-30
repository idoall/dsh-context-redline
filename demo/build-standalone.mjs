// 把 demo 打成「单文件独立版」：内联 CSS/JS。
// 用途：file:// 双击即可打开、可放进 GUI 预览、可 AirDrop 到手机 —— 完全不依赖本地服务。
// 用法：node demo/build-standalone.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const dir = new URL('./', import.meta.url);
const rd = (f) => readFileSync(new URL(f, dir), 'utf8');

let html = rd('redline-panel.html');
const css = rd('demo.css');
const js = rd('demo.js');

html = html.replace('<link rel="stylesheet" href="./demo.css?v=1" />', `<style>\n${css}\n</style>`);
html = html.replace('<script src="./demo.js?v=1"></script>', `<script>\n${js}\n</script>`);

// 只查「外链标签」是否还在：JS 注释里出现 demo.js 是正常的，别误判（这里踩过一次）
if (html.includes('href="./demo.css') || html.includes('src="./demo.js')) {
  console.error('内联失败：仍有外链标签');
  process.exit(1);
}

const out = new URL('redline-panel.standalone.html', dir);
writeFileSync(out, html);
console.log(`已生成 ${out.pathname}（${html.length} bytes，无外链）`);
