// The curved LCD font of US 4,982,181, as a shared painter.
//
// Franklin's "Alphanumeric Display" patent (Peter N. Yianilos, filed 1989) drove
// a 32x202 grid as 148 character templates, each an 8x5 pixel matrix. Its claim:
// the centre-row pixels are "substantially square", while the upper and lower rows
// "have corners that define a parallelogram and vertical edges that are curved" —
// every column runs a shallow vertical S.
//
// This file carries the 5x7 bitmap font (descenders in the 8th row) and the
// canvas painter that lays each lit cell down with that S offset. `demo-reader.html`
// and `demo-device.html` both draw their screens through it; it is loaded the same
// way `nav.js` is, so the pages do not each carry a copy of the glyph table.
//
// Geometry is in *glyph-pixel units*: a cell is GW x GH units, glyphs advance by
// CW units and lines by CH units. Multiply by a pixel size `u` at draw time.
(function (global) {
  "use strict";

  const B0 = "00000";
  const GLYPHS = {
    "A": ["01110","10001","10001","11111","10001","10001","10001",B0],
    "B": ["11110","10001","10001","11110","10001","10001","11110",B0],
    "C": ["01110","10001","10000","10000","10000","10001","01110",B0],
    "D": ["11110","10001","10001","10001","10001","10001","11110",B0],
    "E": ["11111","10000","10000","11110","10000","10000","11111",B0],
    "F": ["11111","10000","10000","11110","10000","10000","10000",B0],
    "G": ["01110","10001","10000","10111","10001","10001","01111",B0],
    "H": ["10001","10001","10001","11111","10001","10001","10001",B0],
    "I": ["01110","00100","00100","00100","00100","00100","01110",B0],
    "J": ["00111","00010","00010","00010","10010","10010","01100",B0],
    "K": ["10001","10010","10100","11000","10100","10010","10001",B0],
    "L": ["10000","10000","10000","10000","10000","10000","11111",B0],
    "M": ["10001","11011","10101","10101","10001","10001","10001",B0],
    "N": ["10001","11001","10101","10101","10011","10001","10001",B0],
    "O": ["01110","10001","10001","10001","10001","10001","01110",B0],
    "P": ["11110","10001","10001","11110","10000","10000","10000",B0],
    "Q": ["01110","10001","10001","10001","10101","10010","01101",B0],
    "R": ["11110","10001","10001","11110","10100","10010","10001",B0],
    "S": ["01111","10000","10000","01110","00001","00001","11110",B0],
    "T": ["11111","00100","00100","00100","00100","00100","00100",B0],
    "U": ["10001","10001","10001","10001","10001","10001","01110",B0],
    "V": ["10001","10001","10001","10001","10001","01010","00100",B0],
    "W": ["10001","10001","10001","10101","10101","11011","10001",B0],
    "X": ["10001","10001","01010","00100","01010","10001","10001",B0],
    "Y": ["10001","10001","01010","00100","00100","00100","00100",B0],
    "Z": ["11111","00001","00010","00100","01000","10000","11111",B0],

    "a": [B0,B0,"01110","00001","01111","10001","01111",B0],
    "b": ["10000","10000","11110","10001","10001","10001","11110",B0],
    "c": [B0,B0,"01110","10000","10000","10001","01110",B0],
    "d": ["00001","00001","01111","10001","10001","10001","01111",B0],
    "e": [B0,B0,"01110","10001","11111","10000","01110",B0],
    "f": ["00110","01000","01000","11100","01000","01000","01000",B0],
    "g": [B0,B0,"01111","10001","10001","01111","00001","01110"],
    "h": ["10000","10000","11110","10001","10001","10001","10001",B0],
    "i": ["00100","00000","01100","00100","00100","00100","01110",B0],
    "j": ["00010","00000","00010","00010","00010","10010","01100",B0],
    "k": ["10000","10000","10010","10100","11000","10100","10010",B0],
    "l": ["01100","00100","00100","00100","00100","00100","00110",B0],
    "m": [B0,B0,"11010","10101","10101","10001","10001",B0],
    "n": [B0,B0,"11110","10001","10001","10001","10001",B0],
    "o": [B0,B0,"01110","10001","10001","10001","01110",B0],
    "p": [B0,B0,"11110","10001","10001","11110","10000","10000"],
    "q": [B0,B0,"01111","10001","10001","01111","00001","00001"],
    "r": [B0,B0,"10110","11001","10000","10000","10000",B0],
    "s": [B0,B0,"01111","10000","01110","00001","11110",B0],
    "t": ["01000","01000","11100","01000","01000","01001","00110",B0],
    "u": [B0,B0,"10001","10001","10001","10011","01101",B0],
    "v": [B0,B0,"10001","10001","10001","01010","00100",B0],
    "w": [B0,B0,"10001","10001","10101","10101","01010",B0],
    "x": [B0,B0,"10001","01010","00100","01010","10001",B0],
    "y": [B0,B0,"10001","10001","01111","00001","00001","01110"],
    "z": [B0,B0,"11111","00010","00100","01000","11111",B0],

    "0": ["01110","10001","10011","10101","11001","10001","01110",B0],
    "1": ["00100","01100","00100","00100","00100","00100","01110",B0],
    "2": ["01110","10001","00001","00010","00100","01000","11111",B0],
    "3": ["11111","00010","00100","00010","00001","10001","01110",B0],
    "4": ["00010","00110","01010","10010","11111","00010","00010",B0],
    "5": ["11111","10000","11110","00001","00001","10001","01110",B0],
    "6": ["00110","01000","10000","11110","10001","10001","01110",B0],
    "7": ["11111","00001","00010","00100","01000","01000","01000",B0],
    "8": ["01110","10001","10001","01110","10001","10001","01110",B0],
    "9": ["01110","10001","10001","01111","00001","00010","01100",B0],

    " ": [B0,B0,B0,B0,B0,B0,B0,B0],
    ".": [B0,B0,B0,B0,B0,"01100","01100",B0],
    ",": [B0,B0,B0,B0,B0,"01100","00100","01000"],
    ";": [B0,B0,"01100","01100","00000","01100","00100","01000"],
    ":": [B0,B0,"01100","01100","00000","01100","01100",B0],
    "!": ["00100","00100","00100","00100","00100","00000","00100",B0],
    "?": ["01110","10001","00001","00010","00100","00000","00100",B0],
    "'": ["00100","00100","01000","00000","00000","00000","00000",B0],
    '"': ["01010","01010","01010","00000","00000","00000","00000",B0],
    "(": ["00010","00100","01000","01000","01000","00100","00010",B0],
    ")": ["01000","00100","00010","00010","00010","00100","01000",B0],
    "-": [B0,B0,B0,"01110","00000","00000","00000",B0],
  };

  const GW = 5, GH = 8;   // pixels per glyph cell
  const CW = 6, CH = 10;  // glyph advance and line pitch, in cell units
  const AMP = 0.22;       // default S amplitude, in cell units (peak offset)

  function glyph(ch) {
    if (ch == null) return null;
    return GLYPHS[ch] || GLYPHS[String(ch).toUpperCase()] || null;
  }

  // Horizontal offset, in cell units, for a row boundary y in 0..8. Zero at the
  // top, centre and bottom; a positive lobe through the upper rows, a negative
  // one through the lower. `amp` of 0 gives a plain right-angled grid.
  function makeS(amp) {
    return (y) => amp * Math.sin(Math.PI * y / 4);
  }

  // Paint one glyph. `rows` is an 8-entry bitmap (from `glyph`), `ox`/`oy` the
  // cell's top-left in px, `u` the pixel size, `s` an offset function from `makeS`.
  function paintGlyph(ctx, rows, ox, oy, u, s, opts) {
    const inset = u * 0.06;
    ctx.fillStyle = (opts && opts.ink) || "#232a1c";
    for (let r = 0; r < GH; r++) {
      const line = rows[r] || B0;
      const yT = oy + r * u, yB = yT + u;
      const sT = s(r) * u, sM = s(r + 0.5) * u, sB = s(r + 1) * u;
      for (let c = 0; c < GW; c++) {
        if (line[c] !== "1") continue;
        const xL = ox + c * u + inset, xR = ox + (c + 1) * u - inset;
        ctx.beginPath();
        ctx.moveTo(xL + sT, yT + inset);
        ctx.lineTo(xR + sT, yT + inset);
        ctx.quadraticCurveTo(xR + sM * 1.7, yT + u / 2, xR + sB, yB - inset);
        ctx.lineTo(xL + sB, yB - inset);
        ctx.quadraticCurveTo(xL + sM * 1.7, yT + u / 2, xL + sT, yT + inset);
        ctx.closePath();
        ctx.fill();
      }
    }
  }

  // Paint the 40 unlit pixel wells of one cell, faint, so an empty screen still
  // reads as a matrix.
  function paintWells(ctx, ox, oy, u, s, opts) {
    ctx.fillStyle = (opts && opts.color) || "rgba(0,0,0,0.055)";
    for (let r = 0; r < GH; r++) {
      const yT = oy + r * u;
      const sT = s(r) * u, sB = s(r + 1) * u;
      for (let c = 0; c < GW; c++) {
        const xL = ox + c * u, xR = xL + u;
        ctx.beginPath();
        ctx.moveTo(xL + sT + u * 0.14, yT + u * 0.14);
        ctx.lineTo(xR + sT - u * 0.14, yT + u * 0.14);
        ctx.lineTo(xR + sB - u * 0.14, yT + u - u * 0.14);
        ctx.lineTo(xL + sB + u * 0.14, yT + u - u * 0.14);
        ctx.closePath();
        ctx.fill();
      }
    }
  }

  // Draw a string starting at cell origin (ox, oy). Options: {curve|amp|s, ink,
  // wells, wellColor}. Returns the advance width in px.
  function drawText(ctx, text, ox, oy, u, opts) {
    opts = opts || {};
    const s = opts.s
      || makeS(opts.amp != null ? opts.amp : (opts.curve === false ? 0 : AMP));
    for (let i = 0; i < text.length; i++) {
      const gx = ox + i * CW * u;
      if (opts.wells) paintWells(ctx, gx, oy, u, s, { color: opts.wellColor });
      const rows = glyph(text[i]);
      if (rows && text[i] !== " ") paintGlyph(ctx, rows, gx, oy, u, s, { ink: opts.ink });
    }
    return text.length * CW * u;
  }

  global.LcdFont = {
    B0, GLYPHS, glyph, GW, GH, CW, CH, AMP, makeS, paintGlyph, paintWells, drawText,
  };
})(window);
