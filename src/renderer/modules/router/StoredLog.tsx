import { Download, ScrollText } from 'lucide-react';
import { useState } from 'react';
import { Button, DataTable, EmptyState, ErrorRetry, Field, FilterBar, Select, SkeletonList, Toggle } from '../../components';
import { ROUTER_API, visibleLogEntries, type RouterLogEntry } from './router-api';
import { LOG_COLUMNS } from './RouterTables';
import { useLive } from './useLive';

type LogDay = { day: string; lines: number };
type LogHistory = { day: string; entries: RouterLogEntry[] };

const formatDay = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`;

/** O dia inteiro, uma linha por registo, no feitio do ficheiro que o router escreve. */
function download(history: LogHistory) {
  const text = history.entries.map((entry) => `${entry.time} ${entry.topics} ${entry.message}`).join('\n');
  const url = URL.createObjectURL(new Blob([`${text}\n`], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `registo-router-${history.day}.txt`;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * O registo do router que o ISPM guardou, por dia. Lê-se da base: funciona fora da rede de
 * gestão, ao contrário do registo ao vivo.
 */
export function StoredLog() {
  const days = useLive<LogDay[]>(`${ROUTER_API}/log/days`, true, 60_000);
  const [picked, setPicked] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [showMachine, setShowMachine] = useState(false);
  // Uma resposta que não é a lista (sessão caída, versão antiga) conta como ainda por ler.
  const list = Array.isArray(days.data) ? days.data : null;
  const day = picked ?? list?.[0]?.day ?? null;
  const history = useLive<LogHistory>(`${ROUTER_API}/log/history?day=${day ?? ''}`, day !== null, 60_000);

  if (days.error && !list) return <ErrorRetry message="Não foi possível ler o registo guardado." onRetry={days.reload} />;
  if (!list) return <SkeletonList rows={6} />;
  if (list.length === 0 || day === null) {
    return (
      <EmptyState icon={ScrollText} title="Ainda não há linhas guardadas"
        description="O ISPM guarda o registo do router de 5 em 5 minutos, enquanto estiver na rede de gestão." />
    );
  }

  // A resposta de um dia pode chegar depois de se escolher outro: só serve a do dia à vista.
  const loaded = history.data?.day === day ? history.data : null;
  const needle = search.trim().toLowerCase();
  const rows = visibleLogEntries(loaded?.entries ?? [], { onlyProblems, showMachine })
    // Procura-se pela frase e pela linha do router: um IP ou um MAC estão nas duas.
    .filter((entry) => !needle || `${entry.topics} ${entry.text} ${entry.message}`.toLowerCase().includes(needle))
    // O dia já está escolhido: na coluna fica só a hora.
    .map((entry) => ({ ...entry, time: entry.time.slice(11) }));

  return (
    <>
      <FilterBar className="router-log-bar">
        <Select label="Dia" className="router-log-day" value={day} onChange={(event) => setPicked(event.target.value)}>
          {list.map((item) => (
            <option key={item.day} value={item.day}>{formatDay(item.day)} · {item.lines.toLocaleString('pt-PT')} linhas</option>
          ))}
        </Select>
        <Field type="search" label="Procurar" className="router-log-search" value={search}
          onChange={(event) => setSearch(event.target.value)} placeholder="IP, MAC, tópico ou texto" />
        <Toggle title="Só erros e avisos" wide={false} checked={onlyProblems} onChange={(event) => setOnlyProblems(event.target.checked)} />
        <Toggle title="Manutenção do ISPM" wide={false} checked={showMachine} onChange={(event) => setShowMachine(event.target.checked)} />
        <Button variant="secondary" leadingIcon={<Download size={14} aria-hidden />} disabled={!loaded} onClick={() => loaded && download(loaded)}>
          Exportar .txt
        </Button>
      </FilterBar>
      {history.error && !loaded ? <ErrorRetry message="Não foi possível ler as linhas deste dia." onRetry={history.reload} />
        : !loaded ? <SkeletonList rows={6} />
          : (
            <DataTable
              rows={rows}
              rowKey={(row) => row.id}
              stickyHeader
              defaultSort={{ key: 'Hora', direction: 'desc' }}
              gridTemplateColumns="minmax(96px, 0.4fr) minmax(140px, 0.6fr) minmax(260px, 3fr)"
              columns={LOG_COLUMNS}
              empty={<EmptyState icon={ScrollText} title="Nenhuma linha com esse filtro" description="Limpe a procura, desligue o filtro de erros e avisos ou mostre a manutenção do ISPM." />}
            />
          )}
    </>
  );
}
