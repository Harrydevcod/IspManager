import { Download, RotateCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { UpdateStatus as UpdateReading } from '../../shared/update-status';
import { Button } from './Button';

const megabytes = (bytes: number) => Math.round(bytes / 1_000_000);

/**
 * A atualização automática no rodapé da barra lateral. O instalador tem ~120 MB e pela
 * Starlink leva minutos: sem isto só se dava por ela no fim, e a 2.36 foi instalada à mão
 * por parecer parada. Fora do Electron, ou sem atualização, não ocupa espaço.
 */
export function UpdateStatus() {
  const [reading, setReading] = useState<UpdateReading>({ state: 'idle' });

  useEffect(() => {
    const bridge = window.ispm;
    if (!bridge?.getUpdateStatus || !bridge.onUpdateStatus) return;
    let alive = true;
    void bridge.getUpdateStatus().then((current) => { if (alive) setReading(current); }).catch(() => undefined);
    const stop = bridge.onUpdateStatus(setReading);
    return () => {
      alive = false;
      stop();
    };
  }, []);

  if (reading.state === 'idle') return null;

  if (reading.state === 'error') {
    return <p className="sidebar-update sidebar-update-error" role="status">Atualização falhou; volta a tentar daqui a 6 h.</p>;
  }

  if (reading.state === 'downloaded') {
    return (
      <div className="sidebar-update" role="status">
        <p>ISPM {reading.version} pronto a instalar</p>
        <Button size="sm" variant="secondary" leadingIcon={<RotateCw size={14} aria-hidden />}
          title={`Reiniciar e instalar o ISPM ${reading.version}`}
          onClick={() => void window.ispm?.installUpdate?.()}>
          Reiniciar e instalar
        </Button>
      </div>
    );
  }

  const percent = Math.floor(reading.percent);
  const size = reading.total > 0 ? ` · ${megabytes(reading.transferred)} de ${megabytes(reading.total)} MB` : '';
  return (
    <div className="sidebar-update" role="status" title={`A descarregar o ISPM ${reading.version}: ${percent} %`}>
      <p>
        <Download size={14} aria-hidden />
        <span>A descarregar {reading.version} · {percent} %{size}</span>
      </p>
      <progress max={100} value={percent} aria-label={`Descarga do ISPM ${reading.version}`} />
    </div>
  );
}
