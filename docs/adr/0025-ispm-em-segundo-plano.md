# 0025 — ISPM em segundo plano

Data: 2026-11-15

## Contexto

Os automatismos executam no processo da aplicação. Fechar a janela terminava esse
processo, interrompendo avisos, cobranças e sincronização com o telemóvel.

## Decisão

Na aplicação empacotada, fechar a janela esconde-a por omissão. Um ícone na
bandeja permite abrir o ISPM ou sair explicitamente. O menu Ficheiro › Sair,
a instalação de atualizações e o encerramento da sessão Windows terminam o
processo. Se a bandeja não puder ser criada, a janela nunca fica inacessível.

As preferências são locais ao perfil do computador, independentes da base de
negócio e do cofre. `background.json` guarda apenas `keepRunning`, com escrita
por substituição. A opção aplica-se imediatamente. O arranque Windows fica
desligado por omissão; a configuração do sistema operativo é a fonte de verdade,
incluindo a desativação no Gestor de Tarefas. O executável arranca com `--hidden`.

O IPC aceita uma única opção booleana e apenas pedidos do frame principal da
janela da aplicação. O renderer não escolhe executáveis, argumentos ou caminhos.
As opções só aparecem nos Automatismos para o administrador, na app empacotada.

Uma execução com `ISPM_DATA_DIR` grava a preferência nessa pasta isolada e não
pode registar o executável de ensaio no arranque Windows. Não existe arranque
automático configurável em Linux/macOS nesta entrega.

## Consequências

O PC precisa de estar ligado e acordado. Isto não é um serviço Windows, não
executa antes do login nem impede suspensão/hibernação. A instalação diferida
de uma atualização ocorre ao escolher Sair, não ao esconder a janela.

## Verificação

Testes de decisão e do controlador cobrem persistência, fecho/restauro, saída,
encerramento Windows, isolamento do ensaio, falha da bandeja e validação de IPC.
O smoke empacotado é necessário para comprovar o ciclo de vida real.
