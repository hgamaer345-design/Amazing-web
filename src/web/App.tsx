import { Link, Route, Routes } from 'react-router-dom';
import { AppConfigProvider, useAppConfig } from './lib/config';
import HomePage from './pages/HomePage';
import TranscriptPage from './pages/TranscriptPage';

function ConfigBanner() {
  const { config, loaded, error } = useAppConfig();
  if (!loaded) return null;
  if (error) {
    return (
      <div className="banner banner-error" role="alert">
        Can’t reach the server: {error}
      </div>
    );
  }
  if (!config.providerConfigured) {
    return (
      <div className="banner banner-warning" role="alert">
        Transcription isn’t set up on this server yet. An administrator needs to set a speech-to-text API key
        (for example <code>ASSEMBLYAI_API_KEY</code>) in the server environment. Existing transcripts can
        still be viewed.
      </div>
    );
  }
  return null;
}

function NotFound() {
  return (
    <div className="page-narrow">
      <div className="card empty-state">
        <h1>Page not found</h1>
        <p>
          <Link to="/">Go to the home page</Link>
        </p>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <AppConfigProvider>
      <div className="app-shell">
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <header className="app-header">
          <Link to="/" className="brand" aria-label="Speaker Transcriber home">
            <img src="/favicon.svg" alt="" width={28} height={28} />
            <span>Speaker Transcriber</span>
          </Link>
          <nav className="app-nav">
            <Link to="/" className="btn btn-primary btn-sm">
              New transcription
            </Link>
          </nav>
        </header>
        <ConfigBanner />
        <main id="main" className="app-main">
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/t/:id" element={<TranscriptPage />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </main>
      </div>
    </AppConfigProvider>
  );
}
