import { HistoryList } from '../components/home/HistoryList';
import { UploadPanel } from '../components/home/UploadPanel';
import '../components/home/home.css';

const FEATURES = [
  { title: 'Who said what', text: 'A new row every time the speaker changes, colour-coded per speaker.' },
  { title: 'Listen along', text: 'Click any line to jump the audio there; the current line lights up.' },
  {
    title: 'Edit & export',
    text: 'Rename speakers, fix text, merge rows — then export to Word, Excel, SRT…',
  },
];

export default function HomePage() {
  return (
    <div className="home">
      <section className="hero">
        <p className="hero-eyebrow">Speaker-separated transcription</p>
        <h1 className="hero-title">
          Turn recordings into <span className="hero-accent">clear, speaker-by-speaker</span> transcripts
        </h1>
        <p className="hero-sub">
          Upload an interview, meeting or podcast. We detect the language and every speaker, and give you an
          editable transcript synced to the audio.
        </p>
        <ul className="hero-features">
          {FEATURES.map((f, i) => (
            <li key={f.title} className="hero-feature" style={{ animationDelay: `${i * 80}ms` }}>
              <span className="hero-feature-num" aria-hidden="true">
                {i + 1}
              </span>
              <span>
                <strong>{f.title}</strong>
                <span className="hero-feature-text">{f.text}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>
      <UploadPanel />
      <HistoryList />
    </div>
  );
}
