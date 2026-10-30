import { Plus, X } from 'lucide-react';
import { useMemo, useState, type DragEvent, type FormEvent, type KeyboardEvent } from 'react';
import { EQUIPMENT_PRESETS, presetInCatalog, type EquipmentPreset } from '../../../shared/equipment-presets';
import { Button, Field } from '../../components';
import type { BackboneCatalogOption } from './backbone-api';
import { DeviceArt, deviceArtKind } from './device-art';
import './EquipmentPalette.css';

/** O tipo MIME do arrasto da paleta para o canvas: só o id do catálogo viaja. */
export const CATALOG_DRAG_TYPE = 'application/x-ispm-catalog';

const TYPE_LABELS: Record<string, string> = {
  router: 'Routers',
  switch: 'Switches',
  cpe: 'CPE',
  antena: 'Antenas',
  ap: 'Pontos de acesso',
  repetidor: 'Repetidores'
};

const typeLabel = (type: string) => TYPE_LABELS[type] ?? type.charAt(0).toUpperCase() + type.slice(1);

type Props = {
  catalogs: BackboneCatalogOption[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onPick: (catalogId: number) => void;
  onCreateCatalog: (input: EquipmentPreset) => Promise<boolean>;
  onClose: () => void;
};

function matches(item: { brand: string | null; model: string; type: string }, query: string): boolean {
  if (!query) return true;
  return `${item.brand ?? ''} ${item.model} ${item.type}`.toLowerCase().includes(query);
}

function onCardDragStart(event: DragEvent<HTMLButtonElement>, catalogId: number) {
  event.dataTransfer.setData(CATALOG_DRAG_TYPE, String(catalogId));
  event.dataTransfer.effectAllowed = 'copy';
}

function CatalogCard({ item, onPick }: { item: BackboneCatalogOption; onPick: (id: number) => void }) {
  const installed = item.backboneCount ?? 0;
  const stock = item.stockTotal ?? 0;
  return (
    <Button
      variant="ghost"
      className="equipment-card"
      // Registar uma backbone desconta stock: sem unidades o servidor recusa, e o
      // cartão avisa antes do formulário.
      data-stock={stock > 0 ? undefined : 'empty'}
      draggable
      onDragStart={(event) => onCardDragStart(event, item.id)}
      onClick={() => onPick(item.id)}
      title="Clique para registar, ou arraste para o mapa"
    >
      <DeviceArt kind={deviceArtKind(item)} />
      <span className="equipment-card-text">
        <strong>{item.model}</strong>
        <small>{item.brand || 'Sem marca'} · {typeLabel(item.type)}</small>
        <small className="equipment-card-meta">
          {installed} na rede · {stock > 0 ? `${stock} em stock` : 'sem stock'}
        </small>
      </span>
    </Button>
  );
}

export function EquipmentPalette({ catalogs, loading, error, onRetry, onPick, onCreateCatalog, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [type, setType] = useState<string | null>(null);
  const [custom, setCustom] = useState<EquipmentPreset | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const needle = query.trim().toLowerCase();

  const types = useMemo(
    () => [...new Set([...catalogs.map((item) => item.type), ...EQUIPMENT_PRESETS.map((item) => item.type)])].sort(),
    [catalogs]
  );
  const visible = catalogs.filter((item) => (!type || item.type === type) && matches(item, needle));
  const popular = needle || type ? [] : [...catalogs]
    .filter((item) => (item.backboneCount ?? 0) > 0)
    .sort((a, b) => (b.backboneCount ?? 0) - (a.backboneCount ?? 0))
    .slice(0, 4);
  const groups = [...new Set(visible.map((item) => item.type))].sort()
    .map((group) => ({ group, items: visible.filter((item) => item.type === group) }));
  const presets = EQUIPMENT_PRESETS.filter((preset) => !presetInCatalog(preset, catalogs)
    && (!type || preset.type === type) && matches(preset, needle));

  async function addPreset(preset: EquipmentPreset) {
    setSaving(`${preset.brand} ${preset.model}`);
    try {
      return await onCreateCatalog(preset);
    } finally {
      setSaving(null);
    }
  }

  async function submitCustom(event: FormEvent) {
    event.preventDefault();
    if (!custom?.model.trim() || !custom.type.trim()) return;
    const ok = await addPreset({ brand: custom.brand.trim(), model: custom.model.trim(), type: custom.type.trim().toLowerCase() });
    if (ok) setCustom(null);
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
    }
  }

  return (
    <aside className="equipment-palette" aria-label="Catálogo de equipamentos" onKeyDown={onKeyDown}>
      <header className="equipment-palette-head">
        <h2>Equipamentos</h2>
        <Button variant="ghost" size="sm" aria-label="Fechar catálogo" onClick={onClose}><X size={16} aria-hidden /></Button>
      </header>
      <Field
        className="equipment-palette-search"
        label="Pesquisar equipamentos"
        hideLabel
        autoFocus
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Marca, modelo ou tipo"
      />
      <div className="equipment-palette-types" role="group" aria-label="Filtrar por tipo">
        <Button variant="ghost" size="sm" aria-pressed={type === null} onClick={() => setType(null)}>Todos</Button>
        {types.map((item) => (
          <Button key={item} variant="ghost" size="sm" aria-pressed={type === item} onClick={() => setType(type === item ? null : item)}>
            {typeLabel(item)}
          </Button>
        ))}
      </div>

      <div className="equipment-palette-body">
        {loading && <p className="equipment-palette-note">A carregar o catálogo…</p>}
        {error && (
          <p className="equipment-palette-note" role="alert">
            {error} <Button variant="ghost" size="sm" onClick={onRetry}>Tentar novamente</Button>
          </p>
        )}
        {popular.length > 0 && (
          <section aria-label="Mais usados">
            <h3>Mais usados</h3>
            {popular.map((item) => <CatalogCard key={`top-${item.id}`} item={item} onPick={onPick} />)}
          </section>
        )}
        {groups.map(({ group, items }) => (
          <section key={group} aria-label={typeLabel(group)}>
            <h3>{typeLabel(group)}</h3>
            {items.map((item) => <CatalogCard key={item.id} item={item} onPick={onPick} />)}
          </section>
        ))}
        {!loading && !error && groups.length === 0 && presets.length === 0 && (
          <p className="equipment-palette-note">Nenhum equipamento corresponde.</p>
        )}
        {presets.length > 0 && (
          <section aria-label="Modelos de referência">
            <h3>Ainda não estão no catálogo</h3>
            {presets.map((preset) => {
              const key = `${preset.brand} ${preset.model}`;
              return (
                <div key={key} className="equipment-card equipment-card-preset">
                  <DeviceArt kind={deviceArtKind(preset)} />
                  <span className="equipment-card-text">
                    <strong>{preset.model}</strong>
                    <small>{preset.brand} · {typeLabel(preset.type)}</small>
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={saving === key}
                    disabled={saving !== null}
                    aria-label={`Adicionar ${key} ao catálogo`}
                    onClick={() => { void addPreset(preset); }}
                  >
                    <Plus size={14} aria-hidden />
                  </Button>
                </div>
              );
            })}
          </section>
        )}
      </div>

      <footer className="equipment-palette-foot">
        {custom ? (
          <form className="equipment-palette-custom" onSubmit={submitCustom}>
            <Field label="Marca" value={custom.brand} onChange={(event) => setCustom({ ...custom, brand: event.target.value })} />
            <Field label="Modelo" required value={custom.model} onChange={(event) => setCustom({ ...custom, model: event.target.value })} />
            <Field
              label="Tipo"
              required
              list="equipment-palette-types"
              value={custom.type}
              onChange={(event) => setCustom({ ...custom, type: event.target.value })}
            />
            <datalist id="equipment-palette-types">
              {types.map((item) => <option key={item} value={item} />)}
            </datalist>
            <div className="equipment-palette-custom-actions">
              <Button variant="secondary" size="sm" onClick={() => setCustom(null)}>Cancelar</Button>
              <Button type="submit" size="sm" loading={saving !== null}>Adicionar ao catálogo</Button>
            </div>
          </form>
        ) : (
          <Button variant="secondary" size="sm" leadingIcon={<Plus size={14} aria-hidden />} onClick={() => setCustom({ brand: '', model: '', type: '' })}>
            Modelo próprio
          </Button>
        )}
      </footer>
    </aside>
  );
}
