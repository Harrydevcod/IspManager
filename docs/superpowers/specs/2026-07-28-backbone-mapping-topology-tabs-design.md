# Mapeamento físico de backbone e Topologia em abas

## Resumo

O módulo Topologia passa a ter duas abas:

1. **Backbone** — fonte operacional para cadastrar unidades físicas de backbone e
   associar cada equipamento instalado a uma delas.
2. **Topologia** — visualização read-only derivada exclusivamente dos vínculos
   persistidos na primeira aba.

Esta mudança substitui a inferência atual por catálogo (`backbone_qty`) por relações
físicas explícitas e auditáveis. O Stock volta a representar apenas catálogo,
quantidade e movimentos de inventário.

## Objetivos

- Mover a gestão de backbone para o módulo Topologia.
- Representar cada unidade de backbone como entidade física identificável.
- Permitir que cada atribuição física ativa seja associada a um backbone específico.
- Manter histórico completo de associações, remoções e transferências.
- Fazer o mapa Topologia refletir somente relações persistidas.
- Preservar a informação existente durante a migração.
- Manter leitura acessível a todos os perfis e escrita restrita a admin e operador.

## Não objetivos

- Descobrir automaticamente conectividade por ping, SNMP, LLDP ou routing.
- Declarar estado online/offline sem telemetria.
- Modelar enlaces entre backbones nesta entrega.
- Alterar automaticamente movimentos ou saldos de Stock ao cadastrar um backbone.
- Permitir edição direta no canvas da aba Topologia.

## Decisão de arquitetura

### Alternativas consideradas

1. **Chave `backbone_id` diretamente em `service_device_assignments`**
   - Simples, mas perde o histórico de transferências e mistura instalação no cliente
     com a evolução da rede.
2. **Entidades físicas e tabela temporal de vínculos — escolhida**
   - Mantém identidade física, histórico, auditoria e integridade sem transformar o
     banco num grafo genérico.
3. **Tabela genérica de nós e arestas**
   - Flexível para redes arbitrárias, porém introduz complexidade e invariantes que o
     produto ainda não precisa.

### Regra central

`backbone_devices` é a fonte de verdade para unidades de backbone.
`backbone_assignment_links` é a fonte de verdade para a relação entre uma atribuição
física e seu upstream operacional. A aba Topologia não poderá reconstruir, adivinhar
ou inferir essa relação pelo catálogo.

## Experiência do módulo

### Navegação

O cabeçalho do módulo apresenta tabs acessíveis:

- **Backbone** — primeira e default.
- **Topologia** — segunda.

As tabs usam `role="tablist"`, `role="tab"`, `aria-selected`, foco visível e navegação
por teclado. O estado é local ao módulo. Ao entrar pelo menu lateral, a aba Backbone
é aberta por padrão.

### Aba Backbone

A composição desktop é uma workspace de duas áreas:

- coluna de backbones, pesquisável e filtrável;
- detalhe do backbone selecionado com seus equipamentos ligados.

Cada item de backbone mostra:

- nome operacional;
- marca e modelo;
- estado;
- ilha/zona;
- IP principal, quando preenchido;
- quantidade de equipamentos ligados;
- indicador de cadastro provisório ou dados incompletos.

O detalhe contém:

- identidade técnica: serial, asset tag, IP, MAC e localização;
- lista paginada dos equipamentos ligados;
- pesquisa por cliente, código, serviço, IP, MAC, serial, asset ou modelo;
- ação **Associar equipamento**;
- ações de editar, transferir e retirar de serviço;
- ação **Ver na Topologia**, que abre a segunda aba e focaliza o backbone.

Uma área **Sem ligação** torna explícitas as atribuições físicas ativas que ainda não
possuem backbone. O operador pode associar uma ou várias, mas cada atribuição terá no
máximo um vínculo ativo.

Em viewport estreito, a lista vira primeiro nível de navegação e o detalhe ocupa a
tela inteira, com retorno explícito. A associação usa diálogo/bottom sheet, nunca
drag-and-drop como único mecanismo.

### Cadastro e edição

Campos:

- nome operacional obrigatório;
- modelo do catálogo obrigatório;
- estado: `active`, `maintenance` ou `retired`;
- serial, asset tag, IP e MAC opcionais;
- ilha, zona e observações opcionais;
- indicador de identidade provisória somente para registros migrados.

Serial e asset tag, quando informados, são únicos entre backbones não retirados.
IP e MAC são normalizados antes da persistência.

Um backbone com vínculos ativos não pode ser apagado. Para retirá-lo de serviço, os
equipamentos devem ser transferidos ou desvinculados primeiro. Registros usados no
histórico são retirados de serviço, não destruídos.

### Associação e transferência

- A associação aceita apenas atribuições físicas ativas.
- Uma restrição única garante apenas um vínculo ativo por atribuição.
- Transferir encerra o vínculo atual e cria o novo na mesma transação.
- Concorrência ou estado desatualizado retorna `409`, preservando o vínculo vencedor.
- O diálogo informa claramente o cliente, serviço e identidade física afetados.
- Desvincular exige confirmação e deixa o equipamento visível em **Sem ligação**.

### Aba Topologia

O canvas existente é preservado, mas seus dados mudam para:

`Internet / Core ISPM → backbone físico → equipamento atribuído → cliente/serviço`

Cada backbone do mapa corresponde a `backbone_devices.id`, podendo exibir IP, MAC,
serial e localização reais. Cada aresta representa uma associação operacional
persistida. Os rótulos deixam de dizer “inventário” e passam a indicar “ligação
definida”.

Ao ocorrer uma mutação na primeira aba, o módulo incrementa uma revisão local. A aba
Topologia invalida snapshot, cache de ramos, busca e seleção antes de renderizar a
nova revisão. Isso evita mostrar relações antigas depois de uma transferência.

Backbones provisórios e equipamentos sem ligação continuam visíveis nas métricas de
atenção, sem inventar conectividade.

## Modelo de dados

### `backbone_devices`

```sql
CREATE TABLE backbone_devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  catalog_id INTEGER NOT NULL REFERENCES equipment_catalog(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  serial_number TEXT,
  asset_tag TEXT,
  ip_address TEXT,
  mac_address TEXT,
  island TEXT,
  zone TEXT,
  status TEXT NOT NULL
    CHECK(status IN ('active', 'maintenance', 'retired'))
    DEFAULT 'active',
  provisional INTEGER NOT NULL CHECK(provisional IN (0, 1)) DEFAULT 0,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Índices:

- catálogo + estado;
- estado;
- nome normalizado para listagem;
- serial parcial único quando não vazio e não retirado;
- asset tag parcial único quando não vazio e não retirado.

### `backbone_assignment_links`

```sql
CREATE TABLE backbone_assignment_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  backbone_device_id INTEGER NOT NULL
    REFERENCES backbone_devices(id) ON DELETE RESTRICT,
  assignment_id INTEGER NOT NULL
    REFERENCES service_device_assignments(id) ON DELETE RESTRICT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT,
  change_reason TEXT,
  created_by INTEGER REFERENCES users(id),
  ended_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Índices e invariantes:

- índice parcial único por `assignment_id WHERE ended_at IS NULL`;
- índice por `backbone_device_id, ended_at`;
- índice por `assignment_id, started_at`;
- `ended_at` nunca anterior a `started_at`;
- encerramento de uma atribuição de serviço também encerra defensivamente seu vínculo
  ativo, dentro da mesma transação.

## Migração

A migração seguinte à atual cria as tabelas e converte cada
`equipment_catalog.backbone_qty` em unidades físicas provisórias:

- quantidade `N` gera `N` registros;
- nomes determinísticos: `<marca> <modelo> #1`, `#2`, …;
- `provisional = 1`;
- nenhum equipamento é associado automaticamente;
- nenhum serial, IP, MAC ou localização é inventado.

Depois de validar a quantidade criada, a migração remove `backbone_qty`. Todo cálculo
financeiro que usava esse campo passa a contar backbones não retirados agrupados por
catálogo. O formulário, filtros, badges, ordenação e coluna Backbone saem do Stock.

Backups antigos continuam compatíveis porque executam a migração ao serem restaurados.

## API

Todas as rotas exigem autenticação. Leitura aceita `admin`, `operator` e `technician`;
mutação aceita somente `admin` e `operator`.

### Gestão

- `GET /api/topology/backbones`
  - lista paginada, filtros, contagens e dados resumidos;
- `POST /api/topology/backbones`
  - cria unidade física;
- `GET /api/topology/backbones/:id`
  - detalhe e equipamentos ligados;
- `PATCH /api/topology/backbones/:id`
  - edição com controle otimista por `updatedAt`;
- `GET /api/topology/assignments`
  - busca paginada por `linked`, `unlinked`, backbone e texto;
- `PUT /api/topology/assignments/:assignmentId/backbone`
  - associa ou transfere atomicamente;
- `DELETE /api/topology/assignments/:assignmentId/backbone`
  - encerra o vínculo ativo.

Entradas são validadas com Zod. IDs inválidos retornam `400`, ausentes `404`, conflito
de vínculo/versão `409` e violação de papel `403`.

### Read model do canvas

- `GET /api/topology`
  - root lógico, backbones físicos, arestas de core e métricas;
- `GET /api/topology/backbones/:id/clients`
  - equipamentos ativamente vinculados ao backbone físico;
- `GET /api/topology/search`
  - busca em backbones físicos, equipamentos, clientes e serviços.

IDs de canvas continuam estáveis no formato `backbone:<backbone_devices.id>` e
`assignment:<service_device_assignments.id>`.

## Segurança e auditoria

- Autorização é aplicada no backend, independentemente da ocultação de botões.
- Toda criação, edição, associação, transferência, desvinculação e retirada gera
  registro em `audit_log`.
- Metadados de auditoria guardam IDs e transição de estado, sem copiar notas livres
  nem outros dados pessoais desnecessários.
- SQL usa statements parametrizados.
- Transferências e encerramentos usam transações SQLite.
- Exclusões em cascata não podem apagar histórico de rede.

## Performance

- Snapshot inicial permanece pequeno: root, backbones e agregados.
- Ramos continuam carregados sob demanda.
- Listas e pesquisas da primeira aba são paginadas no servidor.
- Índices atendem vínculo ativo, backbone, catálogo e busca operacional.
- React Flow e Dagre continuam no chunk lazy do módulo Topologia.
- A troca de aba não duplica pedidos; uma revisão só invalida dados após mutação.

## Erros e estados vazios

- Falha global oferece retry sem apagar a seleção.
- Falha ao associar mantém diálogo e campos preenchidos.
- Conflito `409` recarrega o estado afetado e explica a mudança concorrente.
- Backbone sem equipamentos mostra orientação para associar.
- Ausência de backbones oferece ação de cadastro para perfis autorizados.
- Técnico vê os mesmos dados, com ações de edição ausentes.

## Acessibilidade e responsividade

- Tabs, listas, diálogos e ações são totalmente operáveis por teclado.
- Associação não depende de cor ou arrastar.
- Estados e contagens possuem texto e anúncios adequados.
- Focus retorna ao elemento originador ao fechar diálogo ou detalhe mobile.
- Reduced motion permanece respeitado no canvas.
- Desktop usa split view; tablet reduz metadados; mobile usa navegação em dois níveis.

## Testes

### Migração e banco

- conversão exata de `backbone_qty` em registros provisórios;
- quantidade zero não gera registro;
- remoção segura da coluna legada;
- índices únicos de serial, asset e vínculo ativo;
- restauração/migração de base antiga sem perda.

### Backend

- CRUD e validação de backbone;
- RBAC para os três papéis;
- associação, transferência e desvinculação;
- concorrência e rollback transacional;
- encerramento de assignment encerra o vínculo;
- auditoria de todas as mutações;
- paginação, filtros e busca;
- snapshot e ramos usam somente vínculos explícitos;
- cálculos financeiros preservam os valores migrados.

### Frontend

- aba Backbone é default;
- navegação acessível entre tabs;
- cadastro, edição e estados vazios;
- busca e paginação;
- associação, transferência e conflito;
- técnico em modo read-only;
- mutação invalida a aba Topologia;
- “Ver na Topologia” focaliza o backbone correto;
- desktop, tablet e mobile.

### Regressão

- suíte completa;
- lint;
- typecheck renderer e main;
- build de produção;
- verificação visual e console sem erros.

## Documentação e compatibilidade

O ADR 0004 será substituído por um novo ADR que registra a relação física explícita.
Ele preservará as limitações sobre telemetria e o root lógico, mas removerá a
inferência por catálogo. Contratos compartilhados, textos do inspector e legenda do
canvas serão atualizados para refletir “ligação definida”.

## Critérios de aceitação

- O módulo abre na aba Backbone.
- O campo e a coluna Backbone não existem mais no Stock.
- Admin/operator conseguem cadastrar backbone e associar/transferir equipamentos.
- Técnico consegue consultar sem editar.
- Nenhuma atribuição possui mais de um backbone ativo.
- A aba Topologia reflete a alteração imediatamente após a troca de aba.
- O canvas não desenha arestas baseadas apenas em modelo ou quantidade.
- Dados legados são preservados como backbones provisórios.
- Histórico, auditoria, testes e documentação cobrem todas as transições.
