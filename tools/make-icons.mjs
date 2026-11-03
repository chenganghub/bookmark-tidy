#!/usr/bin/env node
// 生成扩展图标：系统蓝圆角方块 + 白色书签丝带。零依赖：自己栅格化（每像素 4×4 超采样）、自己编码 PNG。
// 输出 public/icon/{16,32,48,96,128}.png（WXT 会自动写进 manifest 的 icons）。
// 用法：node tools/make-icons.mjs [--preview <目录>]   --preview 另存一张放大 8 倍的 16px 预览图，方便人工看
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import zlib from 'node:zlib'

const { values } = parseArgs({ options: { out: { type: 'string', default: 'public/icon' }, preview: { type: 'string' } } })

const SIZES = [16, 32, 48, 96, 128]
const BLUE = [0x00, 0x7a, 0xff] // 设计规范的 --accent（浅色）
const WHITE = [0xff, 0xff, 0xff]
const SS = 4 // 每个像素 4×4 个采样点

/** 一个尺寸的几何（像素单位）。小尺寸把丝带的边对齐到整像素，16px 也清楚 */
function geometry(size) {
  // 商店要求 128 的图留 16px 透明边（图形 96×96）；96 同比例；小图只留 1/16
  const m = size >= 96 ? size / 8 : Math.max(1, Math.round(size / 16))
  const a = size - 2 * m
  const radius = a * 0.225
  let w = Math.round(a * 0.42)
  if ((size - w) % 2) w += 1 // 左右对称落在整像素上
  const x0 = (size - w) / 2
  const y0 = m + Math.round(a * 0.2)
  const y1 = m + Math.round(a * 0.8)
  const notch = Math.max(2, Math.round(a * 0.18))
  const corner = size >= 32 ? a * 0.05 : 0 // 丝带顶角的小圆角，小图不要
  return { m, a, radius, ribbon: { x0, x1: x0 + w, y0, y1, notch, corner } }
}

function inRoundedSquare(x, y, g, size) {
  const lo = g.m
  const hi = size - g.m
  if (x < lo || x > hi || y < lo || y > hi) return false
  const r = g.radius
  const cx = Math.min(Math.max(x, lo + r), hi - r)
  const cy = Math.min(Math.max(y, lo + r), hi - r)
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
}

function inRibbon(x, y, r) {
  if (x < r.x0 || x > r.x1 || y < r.y0 || y > r.y1) return false
  // 底部的 V 形缺口：中线上缺口深 notch，两边为 0
  const cx = (r.x0 + r.x1) / 2
  const half = (r.x1 - r.x0) / 2
  const cut = r.y1 - r.notch * (1 - Math.abs(x - cx) / half)
  if (y > cut) return false
  // 顶部两个圆角
  const c = r.corner
  if (c > 0 && y < r.y0 + c) {
    if (x < r.x0 + c) return (x - (r.x0 + c)) ** 2 + (y - (r.y0 + c)) ** 2 <= c * c
    if (x > r.x1 - c) return (x - (r.x1 - c)) ** 2 + (y - (r.y0 + c)) ** 2 <= c * c
  }
  return true
}

/** 画一个尺寸，返回 RGBA 像素（Uint8Array，非预乘） */
function render(size) {
  const g = geometry(size)
  const px = new Uint8Array(size * size * 4)
  for (let py = 0; py < size; py++) {
    for (let pxl = 0; pxl < size; pxl++) {
      let blue = 0
      let white = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = pxl + (sx + 0.5) / SS
          const y = py + (sy + 0.5) / SS
          if (!inRoundedSquare(x, y, g, size)) continue
          if (inRibbon(x, y, g.ribbon)) white++
          else blue++
        }
      }
      const n = SS * SS
      const alpha = (blue + white) / n
      const i = (py * size + pxl) * 4
      if (alpha === 0) continue
      // 覆盖范围内按面积混合蓝和白
      for (let k = 0; k < 3; k++) px[i + k] = Math.round((BLUE[k] * blue + WHITE[k] * white) / (blue + white))
      px[i + 3] = Math.round(alpha * 255)
    }
  }
  return px
}

// ---------------------------------------------------------------- PNG 编码

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // 位深
  ihdr[9] = 6 // RGBA
  // 10 压缩、11 过滤、12 隔行：都是 0
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0 // 每行过滤方式 None
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1)
  }
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

/** 最近邻放大，预览小图用 */
function upscale(rgba, size, k) {
  const out = new Uint8Array(size * k * size * k * 4)
  for (let y = 0; y < size * k; y++)
    for (let x = 0; x < size * k; x++) {
      const s = ((Math.floor(y / k) * size + Math.floor(x / k)) * 4) | 0
      out.set(rgba.subarray(s, s + 4), (y * size * k + x) * 4)
    }
  return out
}

fs.mkdirSync(values.out, { recursive: true })
for (const size of SIZES) {
  const px = render(size)
  const file = path.join(values.out, `${size}.png`)
  fs.writeFileSync(file, encodePng(size, size, px))
  console.log(`${file}  ${fs.statSync(file).size} B`)
  if (values.preview && size === 16) {
    fs.mkdirSync(values.preview, { recursive: true })
    const big = path.join(values.preview, 'icon-16-x8.png')
    fs.writeFileSync(big, encodePng(128, 128, upscale(px, 16, 8)))
    console.log(`预览：${big}`)
  }
}
