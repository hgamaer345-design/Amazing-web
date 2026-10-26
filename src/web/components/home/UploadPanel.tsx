import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ERROR_MESSAGES } from '../../../shared/errors';
import type { QualityMode } from '../../../shared/types';
import { ApiError, uploadTranscript, type UploadHandle } from '../../api';
import { useNow, useUsage } from '../../hooks/useUsage';
import { decodeWaveform, readAudioDuration, type Waveform } from '../../lib/audioAnalysis';
import { useAppConfig } from '../../lib/config';
import { validateAudioFile } from '../../lib/fileValidation';
import { setSessionAudio } from '../../lib/sessionAudio';
import { UploadSpeedMeter } from '../../lib/uploadSpeed';
import ProcessingSteps from '../ProcessingSteps';
import { Dropzone } from './Dropzone';
import { FileCard } from './FileCard';
import { QualityPicker, remainingUses } from './QualityPicker';

interface Selected {
  file: File;
  url: string;
  durationSec: number | null;
  waveform: Waveform | null;
  analysing: boolean;
}

interface UploadState {
  loaded: number;
  total: number;
  etaSeconds: number | null;
}

/** Choose a file, set options and upload it; on success opens the transcript page. */
export function UploadPanel() {
  const navigate = useNavigate();
  const { config } = useAppConfig();
  const { usage, refresh: refreshUsage } = useUsage();
  const now = useNow(30_000);
  const modes = config.qualityModes;
  const speakersId = useId();
  const keepId = useId();

  const [selected, setSelected] = useState<Selected | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [speakers, setSpeakers] = useState<number | null>(null);
  const [keepAudio, setKeepAudio] = useState(false);
  const [quality, setQuality] = useState<QualityMode>(config.defaultQuality);
  const [notice, setNotice] = useState<string | null>(null);
  const [upload, setUpload] = useState<UploadState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const handleRef = useRef<UploadHandle | null>(null);
  // Resolves with the measured duration once the chosen file has been analysed.
  const analysisRef = useRef<Promise<number | null> | null>(null);
  const cancelledRef = useRef(false);
  // Object URLs are revoked when replaced or on unmount, unless handed to the transcript page.
  const urlRef = useRef<string | null>(null);

  useEffect(
    () => () => {
      handleRef.current?.abort();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  // If Ultra High runs out (e.g. used up in another tab), fall back to High and say why.
  const selectedMode = modes.find((m) => m.id === quality);
  useEffect(() => {
    if (selectedMode && remainingUses(selectedMode, usage) === 0) {
      setQuality('high');
      setNotice(
        `You’ve used today’s free ${selectedMode.label} transcriptions, so High is selected instead.`,
      );
    }
  }, [selectedMode, usage]);

  const chooseFile = useCallback(
    (file: File) => {
      setError(null);
      const issue = validateAudioFile(file, {
        maxBytes: config.maxUploadBytes,
        acceptedExtensions: config.acceptedExtensions,
      });
      if (issue) {
        setProblem(issue.message);
        return;
      }
      setProblem(null);
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      const url = URL.createObjectURL(file);
      urlRef.current = url;
      setSelected({ file, url, durationSec: null, waveform: null, analysing: true });
      analysisRef.current = Promise.all([readAudioDuration(url), decodeWaveform(file)]).then(
        ([durationSec, waveform]) => {
          const measured = durationSec ?? waveform?.durationSec ?? null;
          setSelected((cur) =>
            cur?.url === url ? { ...cur, durationSec: measured, waveform, analysing: false } : cur,
          );
          return measured;
        },
      );
    },
    [config.acceptedExtensions, config.maxUploadBytes],
  );

  const removeFile = () => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
    setSelected(null);
    setError(null);
  };

  const start = async () => {
    if (!selected || upload) return;
    setError(null);
    setNotice(null);
    cancelledRef.current = false;
    const meter = new UploadSpeedMeter();
    const total = selected.file.size;
    setUpload({ loaded: 0, total, etaSeconds: null });
    // The server reads the duration itself, but a browser-measured one is a useful fallback
    // (e.g. WEBM recordings), so give a still-running analysis a moment to finish.
    const durationSec =
      selected.durationSec ??
      (await Promise.race([
        analysisRef.current ?? Promise.resolve(null),
        new Promise<null>((r) => setTimeout(() => r(null), 3000)),
      ]));
    if (cancelledRef.current) {
      setUpload(null);
      return;
    }
    const handle = uploadTranscript(
      selected.file,
      { speakersExpected: speakers, keepAudio, clientDurationSec: durationSec, quality },
      ({ loaded, total: t }) => {
        const { etaSeconds } = meter.sample(loaded, t, Date.now());
        setUpload({ loaded, total: t, etaSeconds });
      },
    );
    handleRef.current = handle;
    handle.promise.then(
      (transcript) => {
        handleRef.current = null;
        setSessionAudio(transcript.id, selected.file);
        void refreshUsage();
        navigate(`/t/${transcript.id}`);
      },
      (err: unknown) => {
        handleRef.current = null;
        setUpload(null);
        if (cancelledRef.current) return;
        if (err instanceof ApiError && err.code === 'QUOTA_EXCEEDED') void refreshUsage();
        setError(err instanceof ApiError ? err.message : ERROR_MESSAGES.INTERNAL);
      },
    );
  };

  const cancel = () => {
    cancelledRef.current = true;
    handleRef.current?.abort();
  };

  const uploading = upload != null;
  const canStart = !!selected && !uploading && config.providerConfigured;
  const modeLabel = selectedMode?.label ?? 'High';

  return (
    <section className="upload-panel card" aria-labelledby="upload-heading">
      <div className="upload-panel-head">
        <h2 id="upload-heading">New transcription</h2>
        <p className="field-hint">
          Your audio is processed securely and deleted after transcription unless you keep it.
        </p>
      </div>

      {uploading && selected ? (
        <div className="upload-progress">
          <ProcessingSteps
            stage="uploading"
            upload={upload}
            fileName={selected.file.name}
            durationSec={selected.durationSec}
          />
          <div className="upload-progress-actions">
            <span className="badge badge-info">{modeLabel} quality</span>
            <button type="button" className="btn btn-sm" onClick={cancel}>
              Cancel upload
            </button>
          </div>
        </div>
      ) : (
        <>
          {selected ? (
            <>
              <FileCard
                file={selected.file}
                url={selected.url}
                durationSec={selected.durationSec}
                analysing={selected.analysing}
                waveform={selected.waveform}
                onRemove={removeFile}
              />
              <Dropzone
                compact
                acceptedExtensions={config.acceptedExtensions}
                maxBytes={config.maxUploadBytes}
                onFile={chooseFile}
              />
            </>
          ) : (
            <Dropzone
              acceptedExtensions={config.acceptedExtensions}
              maxBytes={config.maxUploadBytes}
              onFile={chooseFile}
            />
          )}

          {problem && (
            <div className="alert alert-error" role="alert">
              {problem}
            </div>
          )}

          <div className="upload-options">
            <div className="field">
              <label className="field-label" htmlFor={speakersId}>
                Number of speakers (if known)
              </label>
              <div className="stepper" role="group" aria-label="Number of speakers">
                <button
                  type="button"
                  className="btn btn-icon stepper-btn"
                  aria-label="Fewer speakers"
                  disabled={!config.supportsSpeakerCount || speakers == null}
                  onClick={() => setSpeakers((n) => (n == null || n <= 1 ? null : n - 1))}
                >
                  −
                </button>
                <input
                  id={speakersId}
                  className="input stepper-input"
                  inputMode="numeric"
                  placeholder="Auto"
                  value={speakers ?? ''}
                  disabled={!config.supportsSpeakerCount}
                  aria-describedby={`${speakersId}-hint`}
                  onChange={(e) => {
                    const digits = e.target.value.replace(/\D/g, '');
                    if (!digits) return setSpeakers(null);
                    setSpeakers(Math.min(config.maxSpeakers, Math.max(1, Number(digits))));
                  }}
                />
                <button
                  type="button"
                  className="btn btn-icon stepper-btn"
                  aria-label="More speakers"
                  disabled={!config.supportsSpeakerCount || (speakers ?? 0) >= config.maxSpeakers}
                  onClick={() => setSpeakers((n) => Math.min(config.maxSpeakers, (n ?? 1) + 1))}
                >
                  +
                </button>
              </div>
              <span id={`${speakersId}-hint`} className="field-hint">
                {config.supportsSpeakerCount
                  ? `Leave on Auto to detect it. 1–${config.maxSpeakers}.`
                  : 'The configured transcription service detects the number of speakers automatically.'}
              </span>
            </div>

            <div className="field">
              <span className="field-label" id={`${keepId}-label`}>
                Audio storage
              </span>
              <label className="switch" htmlFor={keepId}>
                <input
                  id={keepId}
                  type="checkbox"
                  role="switch"
                  checked={keepAudio}
                  onChange={(e) => setKeepAudio(e.target.checked)}
                  aria-describedby={`${keepId}-hint`}
                />
                <span className="switch-track" aria-hidden="true">
                  <span className="switch-thumb" />
                </span>
                <span>Keep audio on the server after processing</span>
              </label>
              <span id={`${keepId}-hint`} className="field-hint">
                Otherwise it’s deleted once the transcript is ready. Kept audio lets you replay it from your
                history.
              </span>
            </div>
          </div>

          <QualityPicker
            modes={modes}
            value={quality}
            onChange={(m) => {
              setQuality(m);
              setNotice(null);
            }}
            usage={usage}
            now={now}
            recommended={config.defaultQuality}
          />
          {notice && (
            <div className="alert alert-info" role="status">
              {notice}
            </div>
          )}

          {error && (
            <div className="alert alert-error" role="alert">
              <div className="alert-title">Upload failed</div>
              {error}
            </div>
          )}

          <button
            type="button"
            className="btn btn-primary btn-lg upload-start"
            disabled={!canStart}
            onClick={() => void start()}
          >
            <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
              <path d="M6 4.5v11l9-5.5-9-5.5z" fill="currentColor" />
            </svg>
            Start transcription
            <span className="upload-start-mode">· {modeLabel}</span>
          </button>
          {!selected && <p className="field-hint upload-start-hint">Choose a file to get started.</p>}
        </>
      )}
    </section>
  );
}
