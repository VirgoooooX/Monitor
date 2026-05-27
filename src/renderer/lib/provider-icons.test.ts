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
});
