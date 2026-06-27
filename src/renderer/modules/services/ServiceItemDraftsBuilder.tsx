import type { Dispatch, SetStateAction } from 'react';
import { Button, Field, Message, Select } from '../../components';
import type { StockCatalogRow } from '../../types';

export type ItemDraft = {
  category: 'equipamento' | 'material';
  catalogId: string;
  quantity: string;
  serialNumber: string;
  assetTag: string;
  ipAddress: string;
  macAddress: string;
  notes: string;
};

export function emptyItemDraft(category: 'equipamento' | 'material' = 'equipamento'): ItemDraft {
  return { category, catalogId: '', quantity: '1', serialNumber: '', assetTag: '', ipAddress: '', macAddress: '', notes: '' };
}

type ServiceItemDraftsBuilderProps = {
  drafts: ItemDraft[];
  catalog: StockCatalogRow[];
  onChange: Dispatch<SetStateAction<ItemDraft[]>>;
};

export function ServiceItemDraftsBuilder({ drafts, catalog, onChange }: ServiceItemDraftsBuilderProps) {
  const update = (index: number, patch: Partial<ItemDraft>) =>
    onChange((current) => current.map((draft, i) => i === index ? { ...draft, ...patch } : draft));
  const remove = (index: number) =>
    onChange((current) => current.filter((_, i) => i !== index));
  const add = (category: 'equipamento' | 'material') =>
    onChange((current) => [...current, emptyItemDraft(category)]);

  const renderGroup = (category: 'equipamento' | 'material') => {
    const isMaterial = category === 'material';
    const categoryCatalog = catalog.filter((item) => item.category === category);
    const rows = drafts
      .map((draft, index) => ({ draft, index }))
      .filter((row) => row.draft.category === category);

    return (
      <div className="service-items-group">
        <p className="service-items-group-title">{isMaterial ? 'Materiais' : 'Equipamentos'}</p>
        {rows.length === 0 && (
          <Message>{isMaterial ? 'Sem materiais adicionados.' : 'Sem equipamentos adicionados.'}</Message>
        )}
        {rows.map(({ draft, index }) => {
          const selectedItem = categoryCatalog.find((item) => String(item.id) === draft.catalogId);
          return (
            <div className="service-item-draft" key={index}>
              <Select
                wide
                label={isMaterial ? 'Material' : 'Equipamento'}
                required
                value={draft.catalogId}
                onChange={(event) => update(index, { catalogId: event.target.value })}
              >
                <option value="">{isMaterial ? 'Selecionar material' : 'Selecionar equipamento'}</option>
                {categoryCatalog.map((item) => (
                  <option key={item.id} value={item.id} disabled={item.stockTotal < 1}>
                    {item.brand ? `${item.brand} ${item.model}` : item.model} - {item.type} - {item.stockTotal} {item.unitOfMeasure}
                  </option>
                ))}
              </Select>
              {isMaterial ? (
                <Field
                  label={`Quantidade${selectedItem ? ` (${selectedItem.unitOfMeasure})` : ''}`}
                  required
                  type="number"
                  min={1}
                  max={selectedItem?.stockTotal}
                  value={draft.quantity}
                  onChange={(event) => update(index, { quantity: event.target.value })}
                />
              ) : (
                <>
                  <Field label="Serial" value={draft.serialNumber} onChange={(event) => update(index, { serialNumber: event.target.value })} />
                  <Field label="Asset tag" value={draft.assetTag} onChange={(event) => update(index, { assetTag: event.target.value })} />
                  <Field label="MAC" value={draft.macAddress} onChange={(event) => update(index, { macAddress: event.target.value })} placeholder="AA:BB:CC:DD:EE:FF" />
                  <Field label="IP" value={draft.ipAddress} onChange={(event) => update(index, { ipAddress: event.target.value })} placeholder="192.168.X.Y" />
                </>
              )}
              <Field wide label="Notas" value={draft.notes} onChange={(event) => update(index, { notes: event.target.value })} />
              <Button type="button" variant="secondary" size="sm" onClick={() => remove(index)}>
                Remover linha
              </Button>
            </div>
          );
        })}
        <Button type="button" variant="secondary" size="sm" onClick={() => add(category)}>
          {isMaterial ? 'Adicionar material' : 'Adicionar equipamento'}
        </Button>
      </div>
    );
  };

  return (
    <div className="service-items-builder">
      {renderGroup('equipamento')}
      {renderGroup('material')}
    </div>
  );
}
