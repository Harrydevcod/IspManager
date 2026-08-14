import { describe, expect, it } from 'vitest';
import { speedDisplay } from './PlansModule';
import type { PlanRow } from '../types';

function plan(patch: Partial<PlanRow>): PlanRow {
  return {
    downloadSpeed: '',
    uploadSpeed: '',
    downloadMbps: null,
    uploadMbps: null,
    ...patch
  } as PlanRow;
}

describe('speedDisplay', () => {
  it('usa os Mbps numericos quando existem, ignorando o texto legado', () => {
    const result = speedDisplay(plan({ downloadSpeed: '20 Mb/s', uploadSpeed: '20Mb/s', downloadMbps: 20, uploadMbps: 20 }));
    expect(result).toEqual({ value: '20/20', unit: 'Mbps' });
  });

  it('cai no texto legado enquanto o plano nao tiver Mbps', () => {
    expect(speedDisplay(plan({ downloadSpeed: '20 Mb/s', uploadSpeed: '20Mb/s' })))
      .toEqual({ value: '20 Mb/s/20Mb/s', unit: '' });
  });

  it('acrescenta a unidade ao texto legado puramente numerico', () => {
    expect(speedDisplay(plan({ downloadSpeed: '20', uploadSpeed: '10' })))
      .toEqual({ value: '20/10', unit: 'Mbps' });
  });
});
