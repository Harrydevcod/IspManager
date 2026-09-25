import { describe, expect, test } from 'vitest';
import { routerSyncBadge } from './routerSync';

const withProfile = { routerProfile: 'ispm-plano-1' };

describe('routerSyncBadge', () => {
  test('cada estado tem o seu rótulo, tom e explicação', () => {
    expect(routerSyncBadge({ ...withProfile, routerSyncStatus: 'synced', routerSyncDetail: 'Criou o perfil ispm-plano-1 com 20M/20M', routerSyncError: null }))
      .toEqual({ label: 'Pronto', tone: 'success', title: 'Criou o perfil ispm-plano-1 com 20M/20M' });
    expect(routerSyncBadge({ ...withProfile, routerSyncStatus: 'pending', routerSyncDetail: 'O plano precisa de download e upload em Mbps', routerSyncError: null }))
      .toMatchObject({ label: 'Pendente', tone: 'warn' });
    expect(routerSyncBadge({ ...withProfile, routerSyncStatus: 'external', routerSyncDetail: 'feito no router', routerSyncError: null }))
      .toMatchObject({ label: 'Do operador', tone: 'neutral' });
    expect(routerSyncBadge({ ...withProfile, routerSyncStatus: 'dry_run', routerSyncDetail: 'Criaria o perfil', routerSyncError: null }))
      .toMatchObject({ label: 'Em ensaio', tone: 'info' });
  });

  test('o erro mostra o que se tentou e porque falhou', () => {
    expect(routerSyncBadge({ ...withProfile, routerSyncStatus: 'error', routerSyncDetail: 'Criar o perfil X', routerSyncError: 'router ocupado' }))
      .toEqual({ label: 'Erro', tone: 'danger', title: 'Criar o perfil X — router ocupado' });
  });

  test('plano com perfil ainda não lido não inventa estado', () => {
    expect(routerSyncBadge({ ...withProfile, routerSyncStatus: null, routerSyncDetail: null, routerSyncError: null }))
      .toEqual({ label: 'Por ler', tone: 'neutral', title: 'O router ainda não foi lido para este plano.' });
  });

  // Visto no router real: um plano antigo sem nome de perfil dizia "Por
  // sincronizar", mas a sincronização nunca lhe toca até ser gravado.
  test('plano sem nome de perfil diz que só sincroniza depois de gravado', () => {
    expect(routerSyncBadge({ routerProfile: null, routerSyncStatus: null, routerSyncDetail: null, routerSyncError: null }))
      .toEqual({ label: 'Sem perfil', tone: 'neutral', title: 'Grave o plano para lhe dar um perfil PPP e o criar no router.' });
  });
});
