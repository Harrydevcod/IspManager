import { describe, expect, test } from 'vitest';
import { routerSyncBadge } from './routerSync';

describe('routerSyncBadge', () => {
  test('cada estado tem o seu rótulo, tom e explicação', () => {
    expect(routerSyncBadge({ routerSyncStatus: 'synced', routerSyncDetail: 'Criou o perfil ispm-plano-1 com 20M/20M', routerSyncError: null }))
      .toEqual({ label: 'Pronto', tone: 'success', title: 'Criou o perfil ispm-plano-1 com 20M/20M' });
    expect(routerSyncBadge({ routerSyncStatus: 'pending', routerSyncDetail: 'O plano precisa de download e upload em Mbps', routerSyncError: null }))
      .toMatchObject({ label: 'Pendente', tone: 'warn' });
    expect(routerSyncBadge({ routerSyncStatus: 'external', routerSyncDetail: 'feito no router', routerSyncError: null }))
      .toMatchObject({ label: 'Do operador', tone: 'neutral' });
    expect(routerSyncBadge({ routerSyncStatus: 'dry_run', routerSyncDetail: 'Criaria o perfil', routerSyncError: null }))
      .toMatchObject({ label: 'Em ensaio', tone: 'info' });
  });

  test('o erro mostra o que se tentou e porque falhou', () => {
    expect(routerSyncBadge({ routerSyncStatus: 'error', routerSyncDetail: 'Criar o perfil X', routerSyncError: 'router ocupado' }))
      .toEqual({ label: 'Erro', tone: 'danger', title: 'Criar o perfil X — router ocupado' });
  });

  test('plano nunca sincronizado não inventa estado', () => {
    expect(routerSyncBadge({ routerSyncStatus: null, routerSyncDetail: null, routerSyncError: null }))
      .toEqual({ label: 'Por sincronizar', tone: 'neutral', title: 'O router ainda não foi lido para este plano.' });
  });
});
