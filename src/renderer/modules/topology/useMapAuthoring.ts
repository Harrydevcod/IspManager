import { useCallback, useEffect, useMemo, useState } from 'react';
import type { BackboneDeviceSummary, BackboneWriteInput } from '../../../shared/backbone';
import { useToast } from '../../components';
import { useAuth } from '../../lib/auth';
import { createBackboneApi, type BackboneCatalogOption } from './backbone-api';
import { connectBackboneUpstream } from './backbone-linking';

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

  // Só quando o diálogo abre: no arranque do mapa estes pedidos não servem nada.
  useEffect(() => {
    if (!editorOpen) return;
    void loadCatalogs();
    void loadUpstreamOptions();
  }, [editorOpen, loadCatalogs, loadUpstreamOptions]);

  const openEditor = useCallback(() => {
    setError(null);
    setEditorOpen(true);
  }, []);

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

  return {
    canManage,
    editorOpen,
    pending,
    error,
    catalogs,
    catalogLoading,
    catalogError,
    upstreamOptions,
    openEditor,
    closeEditor: () => setEditorOpen(false),
    retryCatalogs: () => { void loadCatalogs(); },
    createDevice,
    connectNodes
  };
}
