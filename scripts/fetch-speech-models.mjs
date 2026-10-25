// Downloads the speaker-diarization models the static demo serves from its own /models/ folder
// (Whisper itself comes from the Hugging Face hub at run time). Files are checksum-verified and
// kept in vendor/speech-models/ (not committed), so later builds don't download them again.
//   node scripts/fetch-speech-models.mjs
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SPEECH_MODELS_DIR = path.join(root, 'vendor/speech-models');

const RELEASES = 'https://github.com/k2-fsa/sherpa-onnx/releases/download';

/** Output file -> where it comes from. Names match SPEAKER_MODEL_FILES in src/web/demo/speech/models.ts. */
const MODELS = [
  {
    // pyannote/segmentation-3.0 (MIT), exported to ONNX by sherpa-onnx.
    file: 'pyannote-segmentation-3.0.onnx',
    url: `${RELEASES}/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2`,
    sha256: '24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488',
    member: 'sherpa-onnx-pyannote-segmentation-3-0/model.onnx',
    memberSha256: '220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079',
  },
  {
    // WeSpeaker ResNet34-LM trained on VoxCeleb (CC BY 4.0), exported to ONNX by sherpa-onnx.
    file: 'wespeaker-voxceleb-resnet34-LM.onnx',
    url: `${RELEASES}/speaker-recongition-models/wespeaker_en_voxceleb_resnet34_LM.onnx`,
    sha256: 'e9848563da86f263117134dfd7ad63c92355b37de492b55e325400c9d9c39012',
  },
];

const MIT_TERMS = `Permission is hereby granted, free of charge, to any person obtaining a copy
  of this software and associated documentation files (the "Software"), to deal
  in the Software without restriction, including without limitation the rights
  to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
  copies of the Software, and to permit persons to whom the Software is
  furnished to do so, subject to the following conditions:

  The above copyright notice and this permission notice shall be included in all
  copies or substantial portions of the Software.

  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
  SOFTWARE.`;

const ATTRIBUTION = `Speaker models used by the in-browser demo

pyannote-segmentation-3.0.onnx
  pyannote/segmentation-3.0 (https://huggingface.co/pyannote/segmentation-3.0),
  converted to ONNX by sherpa-onnx (https://github.com/k2-fsa/sherpa-onnx, Apache-2.0).

  MIT License

  Copyright (c) 2022 CNRS

  ${MIT_TERMS}

wespeaker-voxceleb-resnet34-LM.onnx
  WeSpeaker ResNet34-LM speaker embedding model trained on VoxCeleb, by the WeSpeaker project
  (https://github.com/wenet-e2e/wespeaker), licensed under CC BY 4.0
  (https://creativecommons.org/licenses/by/4.0/). Converted to ONNX by sherpa-onnx (Apache-2.0).
`;

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function download(url, dest) {
  execFileSync(
    'curl',
    ['--fail', '--silent', '--show-error', '--location', '--retry', '3', '-o', dest, url],
    {
      stdio: 'inherit',
    },
  );
}

/** Makes sure every model is in vendor/speech-models/ with the expected contents; returns the directory. */
export function fetchSpeechModels() {
  fs.mkdirSync(SPEECH_MODELS_DIR, { recursive: true });
  for (const model of MODELS) {
    const dest = path.join(SPEECH_MODELS_DIR, model.file);
    const expected = model.memberSha256 ?? model.sha256;
    if (fs.existsSync(dest) && sha256(dest) === expected) continue;

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-model-'));
    try {
      const downloaded = path.join(tmp, path.basename(new URL(model.url).pathname));
      console.log(`Downloading ${model.url}`);
      download(model.url, downloaded);
      if (sha256(downloaded) !== model.sha256) throw new Error(`Checksum mismatch for ${model.url}`);
      let source = downloaded;
      if (model.member) {
        execFileSync('tar', ['-xjf', downloaded, '-C', tmp, model.member], { stdio: 'inherit' });
        source = path.join(tmp, model.member);
        if (sha256(source) !== model.memberSha256) throw new Error(`Checksum mismatch for ${model.member}`);
      }
      fs.copyFileSync(source, dest);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  fs.writeFileSync(path.join(SPEECH_MODELS_DIR, 'ATTRIBUTION.txt'), ATTRIBUTION);
  return SPEECH_MODELS_DIR;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fetchSpeechModels();
  console.log(`Speech models ready in ${path.relative(root, SPEECH_MODELS_DIR)}`);
}
