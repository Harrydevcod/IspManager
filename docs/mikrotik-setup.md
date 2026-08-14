# MikroTik — configuração completa para o ISPM

Guia para deixar o router pronto a servir clientes por PPPoE e a aceitar o controlo de acesso do ISPM
(ADR 0007 e 0008). Feito para ser executado de cima para baixo no terminal do RouterOS (Winbox → *New
Terminal*, ou SSH).

**Versão exigida:** RouterOS **v7** (a REST API não existe na v6).

---

## 0. Antes de começar

Substitui estes valores pelos teus. Estão marcados a `<>` em todo o guia.

| Marcador | Significado | Exemplo |
| --- | --- | --- |
| `<wan>` | Interface de saída para a Internet (Starlink, fibra) | `ether1` |
| `<lan>` | Interface ou bridge para o lado dos clientes | `bridge-clientes` |
| `<rede-gestao>` | Rede de onde o ISPM se liga ao router | `192.168.88.0/24` |
| `<senha-api>` | Senha do utilizador da API (forte, só usada pelo ISPM) | — |

Cópia de segurança antes de tocar em nada:

```routeros
/system backup save name=antes-do-ispm
/export file=antes-do-ispm-config
```

---

## 1. Rede dos clientes (PPPoE)

O intervalo `10.10.0.0/16` abaixo é a rede interna dos clientes PPPoE. Podes usar outro, desde que não
colida com a tua rede de gestão nem com as redes das CPEs.

```routeros
# Endereço do router do lado dos clientes (é o gateway deles)
/ip address add address=10.10.0.1/16 interface=<lan> comment="Gateway PPPoE"

# Bolsa de endereços que o router entrega a cada cliente que autentica
/ip pool add name=pool-clientes ranges=10.10.1.1-10.10.254.254

# Perfil dos clientes. Sem rate-limit aqui de propósito: a velocidade é
# escrita pelo ISPM em cada utilizador, a partir do plano.
/ppp profile add name=clientes local-address=10.10.0.1 remote-address=pool-clientes \
    dns-server=8.8.8.8,1.1.1.1 only-one=yes

# Servidor PPPoE na interface dos clientes
/interface pppoe-server server add service-name=ispm interface=<lan> \
    default-profile=clientes disabled=no one-session-per-host=yes \
    authentication=pap,chap
```

`only-one=yes` e `one-session-per-host=yes` impedem que a mesma conta seja usada em dois sítios ao mesmo
tempo — é o que faz o corte ter efeito real.

---

## 2. Saída para a Internet

```routeros
# NAT: os clientes saem com o IP público do router
/ip firewall nat add chain=srcnat out-interface=<wan> action=masquerade \
    comment="Saida dos clientes PPPoE"

# DNS do próprio router (opcional, se preferires servi-lo em vez do 8.8.8.8)
/ip dns set servers=8.8.8.8,1.1.1.1 allow-remote-requests=yes
```

Se o `allow-remote-requests=yes` ficar ligado, protege o DNS de fora:

```routeros
/ip firewall filter add chain=input protocol=udp dst-port=53 in-interface=<wan> action=drop \
    comment="DNS nao responde a Internet"
/ip firewall filter add chain=input protocol=tcp dst-port=53 in-interface=<wan> action=drop
```

---

## 3. Proteger o acesso ao router

```routeros
# Serviços que não usas — desligados
/ip service disable telnet,ftp,www,api-ssl

# Winbox e SSH só da rede de gestão
/ip service set winbox address=<rede-gestao>
/ip service set ssh address=<rede-gestao>
```

> `api-ssl` (porta 8729) é a API binária antiga. O ISPM **não** a usa — fala pela REST, que vive no
> `www-ssl`. Deixa-a desligada.

---

## 4. Certificado e REST API

É por aqui que o ISPM entra. O certificado é próprio (o router não tem nome público nem CA que o assine)
e é esse certificado que vais fixar no ISPM.

```routeros
# Certificado do serviço HTTPS
/certificate add name=ispm-api common-name=mikrotik-ispm key-size=2048 \
    days-valid=3650 key-usage=tls-server
/certificate sign ispm-api

# REST API: vive no www-ssl
/ip service set www-ssl certificate=ispm-api disabled=no address=<rede-gestao>
```

`address=<rede-gestao>` faz com que a REST só aceite ligações da tua rede — vale a linha.

Confirma o serviço e guarda a impressão digital para comparares no ISPM:

```routeros
/ip service print where name=www-ssl
/certificate print detail where name=ispm-api
```

---

## 5. Utilizador da API (é este que o ISPM usa)

Não uses o `admin`: mudar-lhe a senha um dia partiria a integração, e o `admin` pode tudo quando o ISPM
só precisa de mexer em `/ppp`.

```routeros
# Grupo com o mínimo necessário. `rest-api` é obrigatório para a REST responder.
/user group add name=ispm policy=read,write,api,rest-api

# O utilizador, limitado a entrar só da rede de gestão
/user add name=ispm-api group=ispm password=<senha-api> address=<rede-gestao> \
    comment="Usado pelo ISPM — controlo de acesso"
```

Se o ISPM devolver **401** com a senha certa, acrescenta `web` às políticas:

```routeros
/user group set ispm policy=read,write,api,rest-api,web
```

Teste rápido, do próprio router:

```routeros
/tool fetch url="https://127.0.0.1/rest/system/resource" user=ispm-api password=<senha-api> \
    check-certificate=no output=user
```

---

## 6. No ISPM

Definições → Rede → **Router MikroTik**:

| Campo | Valor |
| --- | --- |
| Endereço do router | o IP do router na tua rede de gestão |
| Porta | `443` (a que aparece no `/ip service print where name=www-ssl`) |
| Utilizador da API | `ispm-api` |
| Senha | a do passo 5 |
| Ensaio | **ligado** (deixa ficar) |

Depois **Testar ligação**. Falha à primeira, de propósito: o certificado é próprio e ainda não é de
confiança. O ISPM mostra a impressão digital SHA-256 — compara-a com a do passo 4, carrega em **Confiar
neste certificado**, grava, e testa outra vez. À segunda responde com a versão do RouterOS e o modelo.

---

## 7. Provar com um cliente de teste

Antes de mexer em clientes reais:

```routeros
/ppp secret add name=teste-ispm password=teste123 service=pppoe profile=clientes \
    comment="ispm:0 — apagar depois do teste"
/ppp secret print
```

No ISPM: **Reconciliar agora**. Em ensaio, deve reportar o `teste-ispm` como *utilizador sem serviço*
(órfão) — e **não** o apaga, que é exatamente o comportamento pretendido. Depois:

```routeros
/ppp secret remove [find name=teste-ispm]
```

---

## 8. O que o ISPM escreve e o que nunca toca

**Escreve** (só em `/ppp`):

- cria `/ppp secret` para serviços que ainda não existem no router, com `comment=ispm:<id do serviço>`
- liga e desliga (`disabled`) esses secrets conforme o estado do serviço no ISPM
- escreve `rate-limit` a partir dos Mbps do plano — **só** se o plano tiver os dois números preenchidos
- remove a sessão em `/ppp active` quando corta, para o corte ter efeito imediato

**Nunca toca**: firewall, NAT, rotas, interfaces, DNS, perfis PPP, utilizadores do router, nem secrets que
não tenham a marca `ispm:` no comentário. Um secret com essa marca e sem serviço correspondente é
**reportado**, nunca apagado.

---

## 9. Do lado do cliente

Para o cliente autenticar por PPPoE, o equipamento dele tem de deixar de fazer NAT e passar a ligar-se:

- **CPE TP-Link (Pharos/CPE710)**: modo *bridge*, e é o router do cliente que disca PPPoE; ou
- **Router do cliente**: WAN em *PPPoE*, com o utilizador e a senha que aparecem na ficha do serviço no
  ISPM.

Enquanto um cliente não estiver em PPPoE, deixa o campo *Utilizador PPPoE* vazio no ISPM: a reconciliação
ignora-o por completo e o corte desse cliente continua a ser trabalho de campo. A migração faz-se ao ritmo
do terreno, cliente a cliente.

---

## 10. Desfazer

```routeros
/interface pppoe-server server disable [find service-name=ispm]
/ip service set www-ssl disabled=yes
/user remove [find name=ispm-api]
/user group remove [find name=ispm]
```

Ou, para voltar tudo atrás, restaurar a cópia do passo 0:

```routeros
/system backup load name=antes-do-ispm
```
