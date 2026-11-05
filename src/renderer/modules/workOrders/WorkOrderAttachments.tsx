import { useEffect, useState } from 'react';
import { MapPin } from 'lucide-react';
import { Button } from '../../components';
import { authFetch } from '../../lib/auth';
import { useAuthenticatedObjectUrl } from '../../lib/download';

type Attachment = { id: number; kind: 'photo' | 'location'; lat: number | null; lon: number | null; takenAt: string | null };

const API = 'http://127.0.0.1:3001/api/work-orders';

function Photo({ orderId, id }: { orderId: number; id: number }) {
  const { objectUrl } = useAuthenticatedObjectUrl(`${API}/${orderId}/attachments/${id}`);
  if (!objectUrl) return <span className="wo-photo wo-photo-loading" aria-hidden />;
  return (
    <a className="wo-photo" href={objectUrl} target="_blank" rel="noreferrer" title="Abrir a foto">
      <img src={objectUrl} alt="Foto da conclusão no terreno" />
    </a>
  );
}

async function openMap(lat: number, lon: number) {
  const url = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=18/${lat}/${lon}`;
  const opened = await window.ispm?.openExternal?.(url);
  if (opened === undefined) window.open(url, '_blank', 'noopener');
}

/** Fotos e posição da conclusão no terreno (app móvel). Sem anexos, não ocupa espaço. */
export function WorkOrderAttachments({ orderId }: { orderId: number }) {
  const [items, setItems] = useState<Attachment[]>([]);

  useEffect(() => {
    let active = true;
    authFetch(`${API}/${orderId}/attachments`)
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: Attachment[]) => { if (active) setItems(rows); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [orderId]);

  if (items.length === 0) return null;
  const photos = items.filter((a) => a.kind === 'photo');
  const place = items.find((a) => a.kind === 'location' && a.lat !== null && a.lon !== null);

  return (
    <div className="wo-attachments" aria-label="Registo do terreno">
      <span className="wo-attachments-label">Registo do terreno</span>
      {photos.length > 0 && (
        <div className="wo-photos">
          {photos.map((p) => <Photo key={p.id} orderId={orderId} id={p.id} />)}
        </div>
      )}
      {place && (
        <Button variant="ghost" size="sm" className="wo-location" leadingIcon={<MapPin size={14} aria-hidden />} onClick={() => void openMap(place.lat!, place.lon!)}>
          Ver no mapa onde foi concluída
        </Button>
      )}
    </div>
  );
}
