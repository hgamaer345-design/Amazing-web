import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { WHISPER_LANGUAGES } from '../../../shared/languages';
import { LanguagePicker, languageOptions } from './LanguagePicker';

describe('languageOptions', () => {
  it('offers every supported language once: common ones first, each group by name', () => {
    const { common, other } = languageOptions();
    expect(common.map((o) => o.name)).toEqual([
      'Arabic',
      'Chinese',
      'English',
      'French',
      'German',
      'Hindi',
      'Italian',
      'Japanese',
      'Korean',
      'Portuguese',
      'Russian',
      'Spanish',
    ]);
    const codes = [...common, ...other].map((o) => o.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect([...codes].sort()).toEqual([...WHISPER_LANGUAGES].sort());
    const names = other.map((o) => o.name);
    expect(names).toEqual([...names].sort(new Intl.Collator('en').compare));
    expect(other.find((o) => o.code === 'jw')?.name).toBe('Javanese');
    // Every language has a real name, not just its code.
    expect(other.every((o) => o.name !== o.code)).toBe(true);
  });
});

describe('LanguagePicker', () => {
  it('detects the language by default and reports a choice as a code (or null)', async () => {
    const onChange = vi.fn();
    const { rerender } = render(<LanguagePicker value={null} onChange={onChange} demo={false} />);
    const select = screen.getByLabelText('Language');
    expect(select).toHaveValue('auto');
    expect(screen.getByRole('option', { selected: true })).toHaveTextContent('Detect automatically');
    expect(screen.getAllByRole('option')).toHaveLength(WHISPER_LANGUAGES.length + 1);

    await userEvent.selectOptions(select, 'French');
    expect(onChange).toHaveBeenLastCalledWith('fr');
    rerender(<LanguagePicker value="fr" onChange={onChange} demo={false} />);
    expect(select).toHaveValue('fr');
    await userEvent.selectOptions(select, 'Detect automatically');
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('says in the demo that other languages may download a larger model', () => {
    const { rerender } = render(<LanguagePicker value={null} onChange={() => {}} demo />);
    const select = screen.getByLabelText('Language');
    expect(select).toHaveAccessibleDescription(/Detected for each speaker\..*larger speech model/);
    rerender(<LanguagePicker value="ja" onChange={() => {}} demo />);
    expect(select).toHaveAccessibleDescription(/may download a larger speech model/);
    rerender(<LanguagePicker value="es" onChange={() => {}} demo />);
    expect(select).toHaveAccessibleDescription('Every speaker is transcribed in this language.');
    rerender(<LanguagePicker value={null} onChange={() => {}} demo={false} />);
    expect(select).toHaveAccessibleDescription('Choose one if automatic detection gets it wrong.');
  });
});
