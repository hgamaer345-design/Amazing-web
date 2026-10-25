import { clearSessionAudio, getSessionAudioUrl, setSessionAudio } from './sessionAudio';

describe('sessionAudio', () => {
  it('stores and revokes object URLs', () => {
    URL.createObjectURL = vi.fn(() => 'blob:1');
    URL.revokeObjectURL = vi.fn();
    expect(getSessionAudioUrl('t1')).toBeNull();
    setSessionAudio('t1', new Blob(['x']));
    expect(getSessionAudioUrl('t1')).toBe('blob:1');
    clearSessionAudio('t1');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:1');
    expect(getSessionAudioUrl('t1')).toBeNull();
  });
});
