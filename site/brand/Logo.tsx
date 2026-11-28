// 站点的字标和圆环标记：页面用 Wordmark 画站名（size 是高度，单位像素），RingMark 是小标记，转起来就是加载动画。
// Wordmark 是 AUTOHOT 的字母变形（SVG）；换站名时重新画一份，保持同样的参数。
import { SITE } from "../site.ts";

/** 字标：综合三家车企字母标的形态——上汽奥迪的超宽扁粗体、阿维塔去横杠的尖顶 A、埃安的斜切折线；两个 O 是圆环（呼应奥迪四环），HOT 的 O 内嵌“热点”圆点。字母随文字颜色，圆点用强调色。 */
export function Wordmark({ size = 24, className = "", title = SITE.name }: { size?: number; className?: string; title?: string }) {
  const glyphs: Record<string, string> = {
    A: "M0 80L35.5 0H46.5L82 80H60.1L41 37L21.9 80Z",
    U: "M0 7V39A41 41 0 0 0 82 39V0L62 7V39A21 21 0 0 1 41 60A21 21 0 0 1 20 39V0Z",
    T: "M0 0H82L75 20H7ZM31 8H51V80H31Z",
    O: "M1 40A40 40 0 1 1 81 40A40 40 0 1 1 1 40ZM21 40A20 20 0 1 1 61 40A20 20 0 1 1 21 40Z",
    H: "M0 7L20 0V80H0ZM62 7L82 0V80H62ZM18 33H64V51H18Z",
  };
  return (
    <svg viewBox="-8 -8 638 96" height={size} width={Math.round((size * 638) / 96)} className={className} aria-label={title} role="img">
      {["A", "U", "T", "O", "H", "O", "T"].map((l, i) => (
        <path key={i} transform={`translate(${i * 90} 0)`} d={glyphs[l]} fill="currentColor" fillRule={l === "O" ? "evenodd" : undefined} />
      ))}
      <circle cx="491" cy="40" r="11.5" className="fill-accent" />
    </svg>
  );
}

/** A ring with a dot; spinning, it is the loader. */
export function RingMark({ className = "", spinning = false }: { className?: string; spinning?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <g style={spinning ? { transformOrigin: "12px 12px", animation: "spin-slow 1.1s linear infinite" } : undefined}>
        <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeDasharray="42 15" />
      </g>
      <circle cx="12" cy="12" r="2.6" fill="currentColor" />
    </svg>
  );
}
