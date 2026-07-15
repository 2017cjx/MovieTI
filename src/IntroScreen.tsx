const SEEN_LEGEND: Array<{ swatchClass: string; icon: string; label: string }> = [
  { swatchClass: "super-like-swatch", icon: "★", label: "Loved it" },
  { swatchClass: "liked-swatch", icon: "✓", label: "Liked it" },
  { swatchClass: "disliked-swatch", icon: "−", label: "Not for me" },
];

export function IntroScreen({ onStart }: { onStart: () => void }) {
  return (
    <main className="screen intro-screen">
      <h1>MovieTI</h1>
      <p className="tagline">
        Tap through movies. We'll figure out what kind of watcher you are.
      </p>

      <div className="legend">
        <p className="legend-group-label">If you've seen it:</p>
        {SEEN_LEGEND.map((item) => (
          <div className="legend-row" key={item.label}>
            <span className={`legend-swatch ${item.swatchClass}`}>{item.icon}</span>
            <span className="legend-label">{item.label}</span>
          </div>
        ))}

        <p className="legend-group-label">If you haven't:</p>
        <div className="legend-row">
          <span className="legend-swatch not-seen-swatch">✕</span>
          <span className="legend-label">Haven't seen it</span>
        </div>
      </div>

      <p className="intro-note">One tap per movie — seen it or not, loved it or not.</p>

      <button className="restart-button" onClick={onStart}>
        Start
      </button>
    </main>
  );
}
