import { describe, expect, test } from 'vitest';
import type { DeviceAssignment } from '../../types';
import { findReplaceTarget } from './findReplaceTarget';

const assignment = (over: Partial<DeviceAssignment> = {}): DeviceAssignment => ({
  id: 1,
  serviceId: 7,
  catalogId: 5,
  catalogType: 'equipamento',
  brand: 'TP-Link',
  model: 'CPE710',
  serialNumber: null,
  assetTag: null,
  ipAddress: '192.168.1.10',
  macAddress: null,
  technicianName: null,
  notes: null,
  startDate: '2026-01-10',
  endDate: null,
  createdAt: '2026-01-10 09:00:00',
  isOwner: 1,
  sharedWithNames: null,
  sharedWith: [],
  ownerClientName: null,
  ownership: 'isp',
  monthlyRentCve: 0,
  ...over
} as DeviceAssignment);

describe('findReplaceTarget', () => {
  test('encontra a atribuição que a Descoberta indicou', () => {
    const list = [assignment({ id: 1 }), assignment({ id: 2 })];
    expect(findReplaceTarget(list, 2, true)?.id).toBe(2);
  });

  test('sem id não abre nada — é o caso de quem veio do mapa', () => {
    expect(findReplaceTarget([assignment()], null, true)).toBeNull();
  });

  test('a atribuição já encerrada não se substitui', () => {
    expect(findReplaceTarget([assignment({ endDate: '2026-05-01' })], 1, true)).toBeNull();
  });

  test('equipamento partilhado de outro serviço não é deste para trocar', () => {
    expect(findReplaceTarget([assignment({ isOwner: 0 })], 1, true)).toBeNull();
  });

  test('sem permissão técnica o atalho não abre a porta', () => {
    expect(findReplaceTarget([assignment()], 1, false)).toBeNull();
  });

  test('um id que já não está na lista não rebenta', () => {
    expect(findReplaceTarget([assignment({ id: 1 })], 99, true)).toBeNull();
  });
});
