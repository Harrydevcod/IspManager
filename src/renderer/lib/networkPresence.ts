export type NetworkPresence = {
  state: 'onsite' | 'offsite' | 'foreign' | 'unknown';
  checkedAt: string;
  detail: string;
};

export const PRESENCE_URL = 'http://127.0.0.1:3001/api/network/presence';

export function presenceMessage(presence: NetworkPresence): string {
  const base = 'Fora da rede de gestão do ISP — monitorização, contagens e reconciliação em pausa. Os dados mostrados são os da última leitura no local.';
  return presence.state === 'foreign' ? `${base} ${presence.detail}` : base;
}
