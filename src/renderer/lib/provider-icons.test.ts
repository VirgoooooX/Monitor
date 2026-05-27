import { describe, expect, it } from 'vitest';
import { getProviderIconSvg } from './provider-icons';

describe('provider-icons mapping', () => {
  it('returns valid SVG markup for new gemini-cli icons and aliases', () => {
    const cliSvg = getProviderIconSvg('gemini-cli');
    const cliAliasSvg = getProviderIconSvg('geminicli');

    expect(cliSvg).not.toBeNull();
    expect(cliSvg).toContain('<svg');

    expect(cliAliasSvg).not.toBeNull();
    expect(cliAliasSvg).toBe(cliSvg);
  });

  it('returns valid SVG markup for gemini-api and generic gemini icons', () => {
    const apiSvg = getProviderIconSvg('gemini-api');
    const genericSvg = getProviderIconSvg('gemini');

    expect(apiSvg).not.toBeNull();
    expect(apiSvg).toContain('<svg');

    expect(genericSvg).not.toBeNull();
    expect(genericSvg).toContain('<svg');

    // api should map to generic gemini color icon
    expect(apiSvg).toBe(genericSvg);
  });

  it('returns valid SVG markup for new xiaomi icons and aliases', () => {
    const xiaomiSvg = getProviderIconSvg('xiaomi');
    const cloudSvg = getProviderIconSvg('xiaomi-cloud');
    const mimoSvg = getProviderIconSvg('xiaomi-mimo');

    expect(xiaomiSvg).not.toBeNull();
    expect(xiaomiSvg).toContain('<svg');

    expect(cloudSvg).not.toBeNull();
    expect(cloudSvg).toBe(xiaomiSvg);

    expect(mimoSvg).not.toBeNull();
    expect(mimoSvg).toBe(xiaomiSvg);
  });

  it('returns null for unregistered/unknown provider keys', () => {
    expect(getProviderIconSvg('unknown-provider')).toBeNull();
    expect(getProviderIconSvg('')).toBeNull();
    expect(getProviderIconSvg('   ')).toBeNull();
  });

  it('returns the same Kiro brand mark for both `kiro` and `kiro-ide` keys', () => {
    const kiroSvg = getProviderIconSvg('kiro');
    const kiroIdeSvg = getProviderIconSvg('kiro-ide');

    expect(kiroSvg).not.toBeNull();
    expect(kiroSvg).toContain('<svg');
    // Sanity-check the vendored asset by looking for the rounded
    // purple square that frames the ghost mark — `#9046FF` is
    // Kiro's brand purple. Picking the colour value (not the
    // mask / path geometry) keeps the assertion tolerant to
    // minor SVG cleanup without going so loose it tolerates a
    // different glyph entirely.
    expect(kiroSvg).toContain('<rect');
    expect(kiroSvg!.toLowerCase()).toContain('#9046ff');

    expect(kiroIdeSvg).toBe(kiroSvg);
  });
});
