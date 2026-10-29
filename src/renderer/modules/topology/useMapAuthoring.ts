import { useCallback, useEffect, useMemo, useState } from 'react';
import type { BackboneDeviceSummary, BackboneWriteInput } from '../../../shared/backbone';
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

  const openEditor = useCallback((seed: BackbonePrefill | null = null) => {
    setError(null);
    setPrefill(seed);
    setEditorOpen(true);
  }, []);

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

  const createDevice = useCallback(async (input: BackboneWriteInput) => {
    setPending(true);
    setError(null);
    try {
      const created = await api.createBackbone(input);
      setEditorOpen(false);
      toast(`${created.name} registado na topologia`, 'success');
      onMutation();
      return true;
    } catch (createError) {
      setError(message(createError));
      return false;
    } finally {
      setPending(false);
    }
  }, [api, onMutation, toast]);

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
    createDevice,
    connectNodes,
    disconnectUpstream,
    linkPending,
    linkError,
    clearLinkError: () => setLinkError(null),
    saveLink
  };
}
