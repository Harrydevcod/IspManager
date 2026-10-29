import { useCallback, useEffect, useMemo, useState } from 'react';
import type { BackboneDeviceDetail, BackboneDeviceSummary, BackboneWriteInput } from '../../../shared/backbone';
import type { EquipmentPreset } from '../../../shared/equipment-presets';
import type { TopologyLinkProperties } from '../../../shared/topology';
import { useToast } from '../../components';
import { useAuth } from '../../lib/auth';
import { createBackboneApi, type BackboneCatalogOption } from './backbone-api';
import { connectBackboneUpstream, disconnectBackboneUpstream } from './backbone-linking';
import type { BackbonePrefill } from './BackboneWorkspace';

/** O suficiente para o campo "Alimentado por" desta rede sem paginar. */
const UPSTREAM_PAGE_SIZE = 100;

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Operação falhou';
}

/** O registo tal como está, pronto a regravar com uma só coisa mudada. */
export function writeInputFrom(detail: BackboneDeviceDetail): BackboneWriteInput {
  return {
    catalogId: detail.catalogId, name: detail.name, status: detail.status,
    serialNumber: detail.serialNumber, assetTag: detail.assetTag,
    ipAddress: detail.ipAddress, macAddress: detail.macAddress,
    wanMode: detail.wanMode, operationMode: detail.operationMode,
    island: detail.island, zone: detail.zone, notes: detail.notes,
    upstreamDeviceIds: detail.upstreams.map((item) => item.id),
    routerInterface: detail.routerInterface, expectedUpdatedAt: detail.updatedAt
  };
}

/**
 * Registar e ligar equipamentos a partir do mapa. Carrega apenas o que o
 * diálogo precisa — montar o `useBackboneWorkspace` inteiro (cinco coleções)
 * para um formulário seria desperdício.
 */
export function useMapAuthoring(onMutation: () => void) {
  const auth = useAuth();
  const { toast } = useToast();
  const api = useMemo(() => createBackboneApi(), []);
  const canManage = auth.isAuthBypassed || auth.hasRole('admin', 'operator');

  const [editorOpen, setEditorOpen] = useState(false);
  // O registo a editar; `null` é registar uma unidade nova.
  const [editing, setEditing] = useState<BackboneDeviceDetail | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // O que a paleta escolheu: o modelo e, se foi largado em cima de um, o montante.
  const [prefill, setPrefill] = useState<BackbonePrefill | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [catalogs, setCatalogs] = useState<BackboneCatalogOption[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [upstreamOptions, setUpstreamOptions] = useState<BackboneDeviceSummary[]>([]);

  const loadCatalogs = useCallback(async () => {
    setCatalogLoading(true);
    setCatalogError(null);
    try {
      setCatalogs(await api.listCatalogs());
    } catch (loadError) {
      setCatalogError(message(loadError));
    } finally {
      setCatalogLoading(false);
    }
  }, [api]);

  const loadUpstreamOptions = useCallback(async () => {
    try {
      const page = await api.listBackbones({
        page: 1, pageSize: UPSTREAM_PAGE_SIZE, status: 'active'
      });
      setUpstreamOptions(page.items);
    } catch {
      /* sem candidatos o campo fica só com "Internet (origem)" — não bloqueia o registo */
      setUpstreamOptions([]);
    }
  }, [api]);

  // Só quando a paleta ou o diálogo abrem: no arranque do mapa estes pedidos não servem nada.
  useEffect(() => {
    if (paletteOpen) void loadCatalogs();
  }, [paletteOpen, loadCatalogs]);
  useEffect(() => {
    if (!editorOpen) return;
    void loadCatalogs();
    void loadUpstreamOptions();
  }, [editorOpen, loadCatalogs, loadUpstreamOptions]);

  const openEditor = useCallback((seed: BackbonePrefill | null = null, detail: BackboneDeviceDetail | null = null) => {
    setError(null);
    setPrefill(seed);
    setEditing(detail);
    setEditorOpen(true);
  }, []);

  /** Lê o registo fresco: o nó do mapa não traz `updatedAt` nem as notas. */
  const withDetail = useCallback(async (deviceId: number, then: (detail: BackboneDeviceDetail) => void | Promise<void>) => {
    try {
      await then(await api.getBackbone(deviceId));
    } catch (loadError) {
      toast(message(loadError), 'error');
    }
  }, [api, toast]);

  /** Editar no mapa é o formulário da aba Backbone; trocar de modelo também se faz aqui. */
  const openEdit = useCallback((deviceId: number) => {
    void withDetail(deviceId, (detail) => openEditor(null, detail));
  }, [openEditor, withDetail]);

  /**
   * Outra unidade igual, pendurada no mesmo sítio. Série, IP, MAC e nome ficam
   * em branco: são da unidade física, e duas não os partilham.
   */
  const duplicate = useCallback((deviceId: number) => {
    void withDetail(deviceId, (detail) => openEditor({
      catalogId: detail.catalogId,
      upstreamDeviceIds: detail.upstreams.map((item) => item.id)
    }));
  }, [openEditor, withDetail]);

  /** Retirar não apaga: o estado passa a `retired` e a unidade volta ao stock. O servidor recusa se ainda alimentar alguém. */
  const retire = useCallback(async (deviceId: number) => {
    let retired = false;
    await withDetail(deviceId, async (detail) => {
      await api.updateBackbone(deviceId, { ...writeInputFrom(detail), status: 'retired' });
      toast(`${detail.name} retirado da rede`, 'success');
      retired = true;
      onMutation();
    });
    return retired;
  }, [api, onMutation, toast, withDetail]);

  /** Um cartão da paleta escolhido: o formulário de sempre, já com o modelo (e o montante). */
  const pickCatalog = useCallback((catalogId: number, upstreamDeviceId: number | null = null) => {
    setPaletteOpen(false);
    openEditor({ catalogId, upstreamDeviceIds: upstreamDeviceId ? [upstreamDeviceId] : [] });
  }, [openEditor]);

  const togglePalette = useCallback(() => setPaletteOpen((open) => !open), []);

  const createCatalog = useCallback(async (input: EquipmentPreset) => {
    try {
      await api.createCatalog(input);
      toast(`${[input.brand, input.model].filter(Boolean).join(' ')} adicionado ao catálogo`, 'success');
      await loadCatalogs();
      return true;
    } catch (createError) {
      toast(message(createError), 'error');
      return false;
    }
  }, [api, loadCatalogs, toast]);

  const submitEditor = useCallback(async (input: BackboneWriteInput) => {
    setPending(true);
    setError(null);
    try {
      const saved = editing ? await api.updateBackbone(editing.id, input) : await api.createBackbone(input);
      setEditorOpen(false);
      toast(editing ? `${saved.name} atualizado` : `${saved.name} registado na topologia`, 'success');
      onMutation();
      return true;
    } catch (createError) {
      setError(message(createError));
      return false;
    } finally {
      setPending(false);
    }
  }, [api, editing, onMutation, toast]);

  const connectNodes = useCallback((sourceNodeId: string, targetNodeId: string) => {
    void connectBackboneUpstream(api, sourceNodeId, targetNodeId)
      .then(() => {
        toast('Ligação gravada', 'success');
        onMutation();
      })
      .catch((connectError) => toast(message(connectError), 'error'));
  }, [api, onMutation, toast]);

  const [linkPending, setLinkPending] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);

  const saveLink = useCallback(async (deviceId: number, upstreamDeviceId: number, link: TopologyLinkProperties) => {
    setLinkPending(true);
    setLinkError(null);
    try {
      await api.updateLink(deviceId, upstreamDeviceId, link);
      toast('Ligação guardada', 'success');
      onMutation();
      return true;
    } catch (saveError) {
      setLinkError(message(saveError));
      return false;
    } finally {
      setLinkPending(false);
    }
  }, [api, onMutation, toast]);

  const disconnectUpstream = useCallback((deviceId: number, upstreamDeviceId: number) => {
    void disconnectBackboneUpstream(api, deviceId, upstreamDeviceId)
      .then(() => {
        toast('Ligação removida', 'success');
        onMutation();
      })
      .catch((disconnectError) => toast(message(disconnectError), 'error'));
  }, [api, onMutation, toast]);

  return {
    canManage,
    editorOpen,
    paletteOpen,
    prefill,
    editing,
    pending,
    error,
    catalogs,
    catalogLoading,
    catalogError,
    upstreamOptions,
    openEditor,
    openPalette: () => setPaletteOpen(true),
    closePalette: () => setPaletteOpen(false),
    togglePalette,
    pickCatalog,
    createCatalog,
    closeEditor: () => setEditorOpen(false),
    retryCatalogs: () => { void loadCatalogs(); },
    submitEditor,
    openEdit,
    duplicate,
    retire,
    connectNodes,
    disconnectUpstream,
    linkPending,
    linkError,
    clearLinkError: () => setLinkError(null),
    saveLink
  };
}
