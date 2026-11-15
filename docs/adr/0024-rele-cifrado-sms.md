# ADR 0024: Relé cifrado para o ISPM SMS

## Estado

Proposto. A implementação e o ensaio ponta a ponta ainda estão por concluir.

## Contexto

O computador comunica com o telemóvel por HTTP assinado na rede local. Fora
dessa rede, o telemóvel pode ter Internet sem estar acessível ao computador.
Um pedido de SMS pode chegar ao telemóvel mesmo quando a resposta se perde;
uma repetição tem de conservar o identificador para não criar outro pedido.

## Decisão

O transporte remoto usa um Cloudflare Worker e uma caixa por pareamento num
Durable Object com SQLite. O computador tenta a rede local primeiro e usa o
relé quando a ligação falha. O serviço em primeiro plano no Android recolhe
pedidos e devolve respostas. O pareamento inicial continua local e exige a
confirmação dos dois lados do ADR 0023; o relé exige pareamento v2.

Os extremos derivam chaves separadas do segredo do pareamento com HKDF-SHA-256.
Pedidos e respostas usam AES-256-GCM, nonces aleatórios de 96 bits e dados
associados que ligam a versão, a direção, a caixa e o identificador da troca.
O Worker guarda apenas envelopes cifrados e metadados de entrega. Não recebe a
chave de cifragem nem interpreta SMS, painéis, eventos ou fotografias.

A criação da caixa exige uma credencial de administração do Worker, guardada
no cofre do desktop. O Worker guarda hashes de credenciais de acesso derivadas
do segredo de pareamento, com capacidades separadas para cada direção. O URL é
HTTPS, não contém credenciais e o Android obtém-no por uma mensagem autenticada
no pareamento local. A revogação do pareamento invalida os segredos antigos nos
extremos; caixas inativas e mensagens expiram no Worker.

Cada pedido tem identificador estável, prazo e limites de tamanho. O Android
regista o resultado antes de confirmar a entrega e devolve-o nas repetições.
A fila do desktop preserva o ID do SMS antes da primeira tentativa, também no
transporte LAN. Uma resposta só é aceite depois de autenticada e associada ao
pedido correspondente. Em caso de resultado incerto, a repetição usa o mesmo ID.
O relé limita o número de mensagens e a ocupação por caixa, limpa mensagens
expiradas e não regista corpos, tokens ou identificadores pessoais em logs.

O Worker não pode garantir disponibilidade nem impedir que o operador do relé
apague ou atrase tráfego. A app deve mostrar falha ou indisponibilidade sem
afirmar que o pedido foi entregue. O protocolo deve rejeitar replay, envelopes
alterados, mensagens fora do prazo e respostas de outra troca.

## Verificação

- Vetores criptográficos comuns ao Node e ao Android, incluindo adulteração e
  separação de direções; sem segredos reais nos testes.
- Worker local: acesso sem credencial, limites, expiração, concorrência, replay,
  perda de resposta, entrega repetida e limpeza.
- Integração PC + Android simulado: LAN, falha de LAN, relé, reinício, resultado
  incerto, revogação e reconexão, sem enviar SMS real.
- CI Android e smoke visual dos ecrãs alterados conforme `AGENTS.md`; teste em
  telemóvel real com APK assinado antes de anunciar uma versão.

## Fontes

- [Limites dos Workers](https://developers.cloudflare.com/workers/platform/limits/)
- [Limites dos Durable Objects](https://developers.cloudflare.com/durable-objects/platform/limits/)
- [API SQLite dos Durable Objects](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
