# ADR 0021: IPTV via VPN — a lista de origens é mantida por um script do ISPM no router

## Estado

Aceite (2026-10-27). Estende o ADR 0007 (a base é a intenção, o router a realidade). Não altera os
ADR 0008, 0011 e 0014.

## Contexto

Alguns clientes vêem IPTV de fornecedores que só funcionam a partir de outro país. O router já tem,
feito à mão:

- um túnel VPN;
- uma tabela de routing própria, com rota de recurso em blackhole;
- regras de mangle que marcam as ligações IPTV de quem está na lista de origens (`IPTV-SPLIT`) e as
  mandam para essa tabela;
- o filtro e o NAT do túnel.

O resto do tráfego do cliente continua pelas WAN normais.

O que falta é a parte que muda todos os dias: **quem está na lista de origens**.

- Para um cliente PPPoE, o IP muda a cada sessão.
- Para um cliente legacy (DHCP), o IP é o da lease do equipamento que o gateway vê, e esse equipamento
  depende do modo da antena e do router do cliente.

O ISPM é uma aplicação de secretária e pode estar fechado. Por isso a lista não pode depender de o
ISPM estar aberto quando o cliente liga.

Há três coisas que não podem ficar presas a nada de hoje:

- **A VPN.** O fornecedor do túnel pode mudar, e o tipo de túnel também (WireGuard, OpenVPN, L2TP…).
  Pode haver mais de um, em recurso.
- **As WAN.** A saída para a internet pode ser um ou vários fornecedores ao mesmo tempo (satélite,
  fibra, rádio, móvel), em balanceamento ou não.
- **A migração.** Os clientes passam de legacy para PPPoE ao ritmo do terreno. O ISPM dá utilizador
  PPPoE a um serviço muito antes de o cliente migrar.

## Decisões

- **A marca é do serviço e vive só no ISPM.** É `services.iptv_vpn` e, opcionalmente, o fornecedor
  IPTV. É técnica e não fatura. Um preço futuro entra pelo serviço audiovisual que já existe
  (`audiovisual_mode`), não por esta marca. Só os serviços activos entram na lista.

- **No router, um script do ISPM mantém a lista.**
  - São o script `ispm-iptv` e dois schedulers (`interval=1m` e `startup`). Seguem o padrão dos
    contadores de consumo (ADR 0015): dono pelo nome, versão e resumo do conteúdo no comentário, e
    código verificado depois de escrito.
  - O ISPM gera o código com a lista embutida dos utilizadores PPPoE e dos MAC legacy dos serviços
    marcados.
  - O script põe na lista o endereço de cada sessão activa desses utilizadores e o de cada lease
    `bound` desses MAC. Tira as entradas `ispm-iptv:*` que já não correspondem.
  - Escreve sempre com `dynamic=yes`. As entradas ficam em RAM e desaparecem num reinício, e o
    scheduler `startup` reconstrói-as.
  - Um IP reatribuído, ou uma sessão que caiu sem aviso, fica certo em menos de um minuto. Com o ISPM
    fechado, o router continua com a última lista.

- **Na migração, o script segue os dois identificadores.**
  - Um serviço com utilizador PPPoE leva também o MAC legacy que a regra de origem lhe calcula. O
    router usa o que existir.
  - Depois da migração, a lease expira e o MAC deixa de casar sozinho. Não há estado de migração para
    manter.
  - O ISPM mostra por onde cada cliente está a entrar (PPPoE, legacy ou nenhum).

- **Aplicar já, quando o ISPM está aberto.** Mudar a marca, ou o equipamento de um serviço marcado,
  regenera o script e corre-o logo. Corre na fila única de escritas (`runExclusive`) e só na rede de
  gestão. Em ensaio mostra o que mudaria, sem escrever. Cada aplicação fica auditada com o antes e o
  depois.

- **O ISPM só toca no que é seu.**
  - Na lista de origens, só nas entradas `ispm-iptv:*`.
  - Na lista de servidores, só nas `ispm-iptv-srv:<id> <nome>`, dos fornecedores IPTV registados no
    ISPM. Estas escrevem-se por comentário exacto e `.id`, nunca por índice.
  - Nunca altera entradas manuais, mangle, filtro, NAT, rotas nem perfis PPP.
  - Uma entrada manual com o endereço de um cliente marcado aparece como "em uso". Uma entrada manual
    com um endereço que já ninguém tem aparece como "obsoleta": depois de uma migração, esse IP legacy
    pode ir parar a outro cliente. Em ambos os casos, é o operador que decide no router.

- **A infraestrutura só se verifica e descobre-se no router.** O ISPM só sabe o nome da lista de
  origens.
  - A regra de mangle que encaminha essa lista diz a tabela.
  - As rotas dessa tabela dizem os túneis, de qualquer tipo e quantos houver.
  - O filtro e o NAT procuram-se por esses túneis, directamente ou por interface-list.
  - Um túnel conta como vivo se a interface está a correr. Num WireGuard, também tem de ter handshake
    nos últimos 3 minutos.
  - Trocar de fornecedor de VPN, ou de tipo de túnel, é só no router, sem mexer no ISPM.
  - O separador lista os túneis do router com o nome e o tipo que lá têm, o que está em uso e o que
    falta a cada um para levar o IPTV. Só informa. Neutro quer dizer que qualquer VPN serve, e não
    que se esconde o nome que ela tem no router.
  - Os tipos de túnel são os que o `/interface` devolve, medidos no CHR 7.24.2: `gre-tunnel`,
    `ipip-tunnel` e outros, e não `gre` nem `ipip`.
  - Criar a infraestrutura fica para uma fase futura. Exigirá guardar a chave do túnel no cofre de
    credenciais (ADR 0012).

- **As WAN nunca se lêem.** A única verificação que lhes toca é a ordem das regras: a primeira regra
  da lista de origens tem de vir antes de qualquer outra marcação no prerouting, e o encaminhamento
  tem de parar ali (`passthrough=no`). Isto apanha uma WAN nova, de qualquer fornecedor, cujas regras
  de balanceamento fiquem por cima.

- **A origem legacy deriva dos modos que já se registam.**
  - Se a antena faz NAT (`router`, `wisp`), é o MAC da antena.
  - Se a antena está em camada 2 e o router do cliente em `router`, é o MAC do router.
  - Se está tudo em camada 2, é o MAC do aparelho IPTV, registado como equipamento do serviço.
  - O MAC é o que o gateway vê. O ISPM valida-o contra as leases e o ARP. Avisa quando o MAC visto é
    o da antena e o modo registado é de camada 2, o que indica WDS desligado ou modo mal registado.
  - Um modo por classificar nunca se adivinha.

## Consequências

- O ISPM passa a escrever em `/ip/firewall/address-list` (só nas suas entradas), `/system/script` e
  `/system/scheduler` (só em `ispm-iptv*`). Continua sem tocar em firewall, rotas e perfis.
- Um cliente que liga espera até um minuto para o IPTV seguir pelo túnel. A ligação já aberta é
  marcada a meio e o leitor volta a ligar.
- Com o túnel em baixo, os clientes marcados ficam sem canais. É o objectivo da rota de recurso.
- O dst-nat de DNS da lista manual "TV inteira" depende do fornecedor da VPN e fica fora do ISPM.

## Alternativas rejeitadas

- **Etiqueta `#iptv` no comentário do secret e `on-up`/`on-down` nos perfis do ISPM.**
  - Só chegaria aos perfis com a marca `ispm:plano:<id>`, e os perfis do operador ficavam de fora.
  - A etiqueta colide com o sufixo `#<serviceId>` da âncora (ADR 0008), e a reconciliação, que
    reescreve o comentário, apagá-la-ia.
  - Juntava um segundo mecanismo para a mesma lista.
- **Um perfil gémeo por plano com `address-list`.** É nativo, mas duplica os perfis, mete a marca no
  motor de desvio (ADR 0014) e obriga o cliente a reconectar para ligar ou desligar.
- **Entradas estáticas escritas pelo ISPM.** Só estariam certas com o ISPM aberto. Um IP PPPoE
  reatribuído com o ISPM fechado daria IPTV pela VPN ao cliente errado.
- **Escolher o túnel nas Definições.** Prende o ISPM a um nome de interface. Trocar de VPN passaria a
  exigir mexer no ISPM, e um túnel de recurso ficava invisível.
