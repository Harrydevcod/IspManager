# Filtros padrão das listagens operacionais

## Objetivo

Fazer com que as listagens operacionais abram focadas nos registos que exigem trabalho corrente, sem retirar o acesso manual aos restantes estados.

## Comportamento

- **Clientes** abre com o filtro de estado `Ativos`.
- **Serviços** abre com o filtro de estado `Ativos`.
- **Pagamentos** abre com o filtro de estado `Pendente`.
- Todas as opções de filtro existentes continuam disponíveis e selecionáveis manualmente, incluindo `Todos`.
- Em cada módulo, `Limpar filtros` restaura o respetivo estado padrão acima, além de limpar os restantes critérios como já faz atualmente.
- Pesquisa, ordenação, paginação, seleção em massa e filtros temporários acionados por outras áreas continuam a funcionar sobre o estado selecionado.

## Arquitetura

A alteração fica na camada de apresentação, nos estados locais de `ClientsModule`, `ServicesModule` e `PaymentsModule`. A API e a base de dados continuam a devolver os mesmos conjuntos completos, evitando uma mudança implícita de contrato para outros consumidores.

Cada módulo terá uma constante nomeada para o estado padrão. A inicialização e a ação `Limpar filtros` usarão a mesma constante para impedir divergência futura.

## Casos especiais

- Em Pagamentos, uma navegação explícita que peça outro estado, como pagamentos em atraso, continua a prevalecer sobre o padrão `Pendente`.
- Registos suspensos, cancelados, pagos, em atraso ou anulados não são eliminados nem ocultados permanentemente; aparecem quando o utilizador escolhe o filtro correspondente ou `Todos`.
- A contagem apresentada acompanha o conjunto filtrado, como já ocorre hoje.

## Testes

Os testes de comportamento cobrirão:

1. O filtro inicial de Clientes mostra apenas clientes ativos.
2. O filtro inicial de Serviços mostra apenas serviços ativos.
3. O filtro inicial de Pagamentos mostra apenas pagamentos pendentes.
4. A seleção manual de outros estados e de `Todos` permanece disponível.
5. `Limpar filtros` repõe o padrão específico de cada módulo.
6. Uma navegação explícita para um estado de Pagamentos continua a substituir o padrão.

A implementação seguirá o ciclo TDD: testes falhando pelo comportamento atual, alteração mínima e validação do conjunto completo.
