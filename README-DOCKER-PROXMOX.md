# Docker y Proxmox VE 9.2

Guía operativa para construir la imagen OCI de **vocab-cards** y desplegar una
sola instancia en Proxmox VE 9.2. La ruta recomendada en este documento importa
la imagen OCI y deja que Proxmox la convierta directamente a un contenedor LXC.
La alternativa con Docker Engine y Compose dentro de un LXC de sistema se
documenta por separado al final.

> **Advertencia oficial:** los **OCI Application Containers** de Proxmox VE 9.2
> son una *technology preview*. Proxmox convierte la imagen OCI a su pila LXC,
> pero esta modalidad todavía no debe tratarse como una función estable. Revisa
> la documentación vigente antes de cada actualización:
> [Proxmox Container Toolkit, OCI Images](https://pve.proxmox.com/pve-docs/chapter-pct.html#_open_container_initiative_oci_images).
> Si se necesita máximo aislamiento o migración en vivo, la propia documentación
> recomienda ejecutar los contenedores dentro de una VM QEMU.

## Alcance y decisión

La aplicación es un proceso Node.js que sirve frontend y API, y usa SQLite en
modo WAL. La imagen se ejecuta como UID/GID `1000:1000`, escucha en el puerto
`3000` y guarda la base en `/data/vocab.db`.

| Ruta | Cuándo elegirla | Ventajas | Costos y límites |
|---|---|---|---|
| **OCI directo convertido a LXC** | Ruta prioritaria para Proxmox VE 9.2 | Sin Docker Engine dentro del CT; gestión directa de CPU, memoria, red y almacenamiento desde Proxmox | *Technology preview*; no usa Compose; actualización y rollback más seguros creando un CT nuevo |
| **Docker Engine + Compose en LXC de sistema** | Cuando se prefiere el flujo Docker conocido o se necesita `compose.yaml` | Reproduce el hardening, healthcheck y volumen declarados en Compose | Contenedores anidados, mayor superficie operativa y requisitos `nesting`/`keyctl` |

En ambas rutas:

- Ejecuta **una sola réplica**. Dos procesos contra el mismo SQLite no son una
  estrategia de alta disponibilidad soportada.
- Conserva todo `/data`, no solo `vocab.db`: SQLite puede mantener archivos
  `vocab.db-wal` y `vocab.db-shm` mientras está activo.
- Termina TLS en un reverse proxy y filtra el acceso al puerto `3000`.
- Define un `ADMIN_TOKEN` largo y aleatorio. Si falta, la aplicación genera uno
  temporal y lo escribe en los logs, lo cual no es apropiado para producción.

## Estado del código fuente

Los cambios actuales de despliegue están **sin commit**. Un `git clone` de un
remoto no los incluirá hasta que se revisen, confirmen y publiquen. Construye la
imagen desde el árbol de trabajo validado o publica primero esos cambios en el
repositorio correspondiente.

## Placeholders

Los comandos usan valores deliberadamente ficticios. Sustitúyelos antes de
ejecutar y no guardes credenciales en el historial de shell.

| Placeholder | Ejemplo conceptual |
|---|---|
| `<REGISTRY>` | Registro OCI corporativo |
| `<NAMESPACE>` | Organización o proyecto del registro |
| `<TAG_INMUTABLE>` | Versión más identificador de build, nunca `latest` |
| `<IMAGE_DIGEST>` | Digest `sha256:...` devuelto por el registro |
| `<CTID>` | ID libre del contenedor en Proxmox |
| `<NODE>` | Nodo Proxmox de destino |
| `<STORAGE>` | Almacenamiento compatible con plantillas y rootfs |
| `<DATA_STORAGE>` | Almacenamiento administrado para `/data` |
| `<BRIDGE>` | Bridge de red, por ejemplo el bridge de servicios |
| `<CT_IP_CIDR>` | IP y prefijo del CT |
| `<GATEWAY>` | Gateway de la red del CT |
| `<FQDN>` | Nombre DNS público o interno de la aplicación |
| `<HOST_SECRET_DIR>` | Directorio dedicado del host Proxmox para secretos |

## Prerrequisitos

- Proxmox VE 9.2 actualizado y acceso administrativo al nodo.
- Almacenamiento habilitado para imágenes/plantillas OCI y almacenamiento para
  el rootfs y `/data`.
- DNS, gateway y bridge definidos antes de crear el CT.
- Un reverse proxy Nginx, Caddy o HAProxy en otro CT/VM o equipo. La imagen de la
  aplicación no incluye Nginx.
- Docker con Buildx en la estación o CI que construirá y publicará la imagen.
- Un registro OCI accesible desde Proxmox, con autenticación si es privado.
- Arquitectura conocida: `linux/amd64` para hosts x86-64 o `linux/arm64` para
  hosts ARM64. No publiques una arquitectura que no hayas probado.
- Directorios y volúmenes preparados para que UID/GID `1000:1000` dentro del CT
  pueda escribir `/data` y leer el archivo de credenciales.

Configuración sugerida para una única instancia de uso personal o de equipo:

| Recurso | Valor inicial | Motivo |
|---|---:|---|
| CPU | 2 cores | Suficiente para Node, SQLite y generaciones concurrentes moderadas |
| RAM | 1024 MiB | Margen para build ya realizado, catálogo y cachés |
| Swap | 512 MiB | Protección limitada ante picos; no sustituye RAM |
| Rootfs | 8 GiB | Imagen y margen operativo |
| `/data` | 4 GiB, ampliable | Base SQLite, WAL y crecimiento de métricas |
| Réplicas | 1 | Evita escritores múltiples sobre SQLite |

Mide consumo real y amplía recursos si el catálogo o las copias crecen. No
reduzcas memoria basándote solo en el estado en reposo.

## 1. Probar y construir la imagen

Ejecuta primero las verificaciones del repositorio:

```bash
npm ci
npm test
npm run build
docker build --pull -t vocab-cards:verify .
```

Prepara directorios temporales de prueba, un token no reutilizado en producción
y un archivo de credenciales vacío. El archivo `{}` deshabilita todos los
proveedores de IA, pero permite validar el arranque:

```bash
mkdir -p .runtime-test/data .runtime-test/secrets
printf '{}\n' > .runtime-test/secrets/credentials.json
docker run --rm --name vocab-cards-verify \
  -e ADMIN_TOKEN='<TOKEN_SOLO_DE_PRUEBA>' \
  -e AI_CREDENTIALS_FILE=/run/secrets/vocab-ai/credentials.json \
  -e HOST=0.0.0.0 \
  -e PORT=3000 \
  -p 127.0.0.1:3000:3000 \
  -v "$(pwd)/.runtime-test/data:/data" \
  -v "$(pwd)/.runtime-test/secrets:/run/secrets/vocab-ai:ro" \
  vocab-cards:verify
```

En otra terminal, comprueba HTTP y detén el contenedor:

```bash
curl --fail --show-error http://127.0.0.1:3000/api/health
docker stop vocab-cards-verify
rm -rf .runtime-test
```

La respuesta esperada es:

```json
{"status":"ok","database":"ok"}
```

El endpoint solo comprueba proceso y SQLite. No consulta proveedores de IA.

## 2. Publicar una imagen OCI inmutable

Usa tags inmutables, por ejemplo `1.0.0-build.20260927.1`, y registra también el
digest. No despliegues `latest`: puede apuntar a contenido distinto durante una
actualización o rollback.

Inicializa un builder si todavía no existe:

```bash
docker buildx create --name vocab-builder --use
docker buildx inspect --bootstrap
```

Publica un manifiesto multi-arquitectura solo después de probar ambas
arquitecturas:

```bash
docker login <REGISTRY>
docker buildx build \
  --pull \
  --platform linux/amd64,linux/arm64 \
  --tag <REGISTRY>/<NAMESPACE>/vocab-cards:<TAG_INMUTABLE> \
  --push .
docker buildx imagetools inspect \
  <REGISTRY>/<NAMESPACE>/vocab-cards:<TAG_INMUTABLE>
```

Para un único host x86-64 se puede publicar solo `linux/amd64`; para ARM64, solo
`linux/arm64`. Conserva en el registro el tag y el digest aprobados:

```text
<REGISTRY>/<NAMESPACE>/vocab-cards:<TAG_INMUTABLE>@<IMAGE_DIGEST>
```

El `Dockerfile` usa Node 24.21.0 sobre Debian Trixie slim, fijado por digest en
ambas etapas. Al actualizar Node, cambia tag y digest juntos, reconstruye y
repite pruebas antes de publicar.

## 3. Preparar almacenamiento, UID y secretos

### `/data` persistente

Prefiere un **mount point administrado por Proxmox** para `/data`, con
`backup=1`, en lugar de un bind mount del host. Así Proxmox puede incluirlo en
`vzdump` cuando el almacenamiento lo soporta. Reserva 4 GiB inicialmente.

La imagen cambia a `USER node`, UID/GID `1000:1000`. Antes del primer arranque,
el mount point debe aparecer dentro del CT con ese propietario y permitir
escritura:

```bash
pct exec <CTID> -- id
pct exec <CTID> -- stat -c '%u:%g %a %n' /data
pct exec <CTID> -- sh -c 'touch /data/.write-test && rm /data/.write-test'
```

Si el proceso todavía no puede arrancar, detén el CT, monta su filesystem con
las herramientas de Proxmox y corrige el propietario del mount point según el
mapeo del CT. No cambies permisos a `0777`.

### Mapeo en un LXC no privilegiado

Usa un CT **no privilegiado**. En el mapeo habitual con offset `100000`, el UID
`1000` del CT corresponde al UID `101000` del host, y lo mismo para GID. Ese
offset es frecuente, pero NO debe asumirse: verifica la configuración efectiva
del CT y los rangos de `/etc/subuid` y `/etc/subgid` del nodo.

Proxmox VE 9.2 también permite `idmap` por mount point con entradas como
`u:<uid-ct>:<uid-disco>:<rango>` y `g:<gid-ct>:<gid-disco>:<rango>`. Configúralo
desde la GUI o `pct` solo después de decidir quién será el propietario real en
el filesystem. Valida siempre desde dentro con `stat`; mezclar un `chown` basado
en offset y un `idmap` personalizado puede producir propietarios incorrectos.

### Directorio de credenciales

Monta el **directorio**, no un archivo individual, en
`/run/secrets/vocab-ai` como solo lectura. Montar el directorio permite sustituir
`credentials.json` atómicamente sin romper el bind mount.

En el host Proxmox, usa un directorio dedicado y el UID/GID del host que mapean
a `1000:1000` dentro del CT:

```bash
install -d -m 0750 -o <UID_HOST_MAPPED> -g <GID_HOST_MAPPED> <HOST_SECRET_DIR>
install -m 0400 -o <UID_HOST_MAPPED> -g <GID_HOST_MAPPED> \
  /dev/null <HOST_SECRET_DIR>/credentials.json
```

Edita el archivo por un medio que no deje el secreto en el historial. Debe ser
un objeto JSON, medir como máximo **16 KiB**, no ser un symlink y contener
únicamente claves de esta allowlist:

```json
{
  "OPENCODE_API_KEY": "<VALOR>",
  "OPENAI_API_KEY": "<VALOR>",
  "ANTHROPIC_API_KEY": "<VALOR>",
  "GEMINI_API_KEY": "<VALOR>",
  "AZURE_OPENAI_API_KEY": "<VALOR>",
  "AI_API_KEY": "<VALOR>"
}
```

Omite las claves no utilizadas. Todos los valores deben ser strings; un campo
desconocido, JSON inválido, array, symlink, archivo no regular o tamaño mayor a
16 KiB hace que las operaciones IA respondan `503`. Cuando se configura
`AI_CREDENTIALS_FILE`, este archivo es autoritativo y las claves equivalentes
del entorno se ignoran.

Valida estructura, tamaño y permisos sin imprimir valores:

```bash
test "$(wc -c < <HOST_SECRET_DIR>/credentials.json)" -le 16384
python3 -m json.tool <HOST_SECRET_DIR>/credentials.json >/dev/null
stat -c '%U:%G %a %s %n' <HOST_SECRET_DIR>/credentials.json
```

El uso de `python3 -m json.tool` solo valida sintaxis. La allowlist la valida la
aplicación en cada operación de IA.

## 4. Importar la imagen OCI en Proxmox

### GUI, ruta confirmada y recomendada

La documentación oficial 9.2 confirma este flujo:

1. Abre el contenido de un almacenamiento que admita plantillas de contenedor.
2. Selecciona **Pull from OCI registry**.
3. Introduce la referencia inmutable de la imagen y las credenciales del
   registro si corresponde.
4. Confirma que la arquitectura de la imagen coincide con el nodo.
5. Espera a que la imagen aparezca como plantilla del almacenamiento.
6. Crea un CT desde esa plantilla mediante el asistente.

La GUI también permite cargar manualmente una imagen OCI. Los nombres exactos de
campos pueden cambiar durante el *technology preview*; no traduzcas una captura
antigua en automatización sin comprobar la versión instalada.

### CLI, alcance seguro

Proxmox confirma que, una vez importada la plantilla OCI al almacenamiento, se
puede crear mediante `pct create`. Obtén primero el identificador real mostrado
por el almacenamiento y revisa la sintaxis instalada:

```bash
pveversion --verbose
pveam list <STORAGE>
pct create --help
pct set --help
```

Plantilla de creación, que debe adaptarse a la red y al almacenamiento del nodo:

```bash
pct create <CTID> <STORAGE>:vztmpl/<PLANTILLA_OCI_IMPORTADA> \
  --hostname vocab-cards \
  --unprivileged 1 \
  --cores 2 \
  --memory 1024 \
  --swap 512 \
  --rootfs <STORAGE>:8 \
  --net0 name=eth0,bridge=<BRIDGE>,ip=<CT_IP_CIDR>,gw=<GATEWAY>,firewall=1
```

No se documenta un comando genérico para hacer el pull OCI por CLI porque el
identificador y las capacidades dependen de la configuración del storage. La
acción **Pull from OCI registry** y la creación por GUI/`pct create` sí están
confirmadas por la documentación oficial.

## 5. Configurar el CT OCI directo

### Recursos y mounts

En **Resources** configura:

- Root disk: 8 GiB.
- CPU: 2 cores.
- Memory: 1024 MiB y swap 512 MiB.
- Mount point administrado: 4 GiB en `/data`, escritura habilitada, `backup=1`.
- Bind mount: `<HOST_SECRET_DIR>` a `/run/secrets/vocab-ai`, solo lectura.

La sintaxis oficial para un volumen administrado nuevo es
`<DATA_STORAGE>:<SIZE_GIB>,mp=<RUTA>`. Después de comprobar el CT creado:

```bash
pct set <CTID> -mp0 <DATA_STORAGE>:4,mp=/data,backup=1
pct set <CTID> -mp1 <HOST_SECRET_DIR>,mp=/run/secrets/vocab-ai,ro=1
pct config <CTID>
```

Los bind mounts no son gestionados por el subsistema de almacenamiento: no
tienen snapshots ni cuotas y **su contenido no se incluye en `vzdump`**. Respalda
el directorio secreto con un procedimiento separado y cifrado. No hagas bind
mount de `/`, `/etc`, `/var` ni otros directorios del sistema host.

### Variables exactas

Configura el entorno del **Application Container** en la GUI de Proxmox 9.2 y
verifica después la configuración efectiva con `pct config <CTID>`. La opción
oficial `env` representa el entorno de runtime; como su serialización CLI usa
una lista separada por NUL, evita construirla con quoting de shell no probado.

Valores base para OCI directo:

```dotenv
HOST=0.0.0.0
PORT=3000
VOCAB_DB=/data/vocab.db
VOCAB_DATA_FOLDER=/app/data/seed
VOCAB_INCLUDE_SUBFOLDERS=false
VOCAB_SEED_FROM_FOLDER_WHEN_EMPTY=true
VOCAB_PAGE_SIZE=12
VOCAB_MAX_PAGE_SIZE=100
VOCAB_MAX_IMPORT_BYTES=5242880
VOCAB_MAX_BACKUP_BYTES=67108864
VOCAB_TRUST_PROXY=1
AI_TIMEOUT_MS=90000
AI_CATALOG_TTL_MS=300000
AI_CATALOG_TIMEOUT_MS=10000
AI_MAX_TERMS=10
AI_CREDENTIALS_FILE=/run/secrets/vocab-ai/credentials.json
ADMIN_TOKEN=<TOKEN_ADMINISTRATIVO_LARGO_Y_ALEATORIO>
```

Opcionales:

```dotenv
VOCAB_CONFIG=/app/config.json
AZURE_OPENAI_ENDPOINT=https://<RECURSO>.openai.azure.com
```

`AZURE_OPENAI_ENDPOINT` no es una credencial y va en el entorno, no en
`credentials.json`. Se admite la raíz `https://<RECURSO>.openai.azure.com`, la
raíz `https://<RECURSO>.services.ai.azure.com` o una URL completa terminada en
`/openai/v1`; la aplicación normaliza las barras y agrega `/openai/v1` cuando
falta. Azure solo se habilita si también existe `AZURE_OPENAI_API_KEY` en el
archivo de credenciales.

Para otros proveedores:

- OpenCode Go: `OPENCODE_API_KEY` en `credentials.json`.
- OpenAI: `OPENAI_API_KEY` en `credentials.json`.
- Anthropic: `ANTHROPIC_API_KEY` en `credentials.json`.
- Gemini: `GEMINI_API_KEY` en `credentials.json`.
- Custom: configura opciones no secretas, incluido `baseUrl`, en otro archivo
  JSON y apunta `VOCAB_CONFIG` a él; usa `AI_API_KEY` salvo `auth: "none"`.
- Ollama: decláralo explícitamente en `ai.providers` dentro del archivo indicado
  por `VOCAB_CONFIG`; no usa clave y no se detecta automáticamente en localhost.

> **OCI directo NO usa `compose.yaml`, `VOCAB_BIND_ADDRESS` ni `VOCAB_PORT`.**
> Esas dos últimas variables solo interpolan el puerto publicado por Compose y
> el código de la aplicación no las lee. En OCI directo usa `HOST` y `PORT`.

La imagen ya contiene el comando de arranque:

```text
node --disable-warning=ExperimentalWarning server/index.js
```

Comprueba que Proxmox haya conservado el entrypoint OCI. Si el preview exige
configurarlo manualmente, usa exactamente ese comando mediante el campo de
entrypoint del Application Container; la opción está documentada por Proxmox,
pero su presentación en GUI puede variar.

## 6. Red, firewall y reverse proxy

Asigna una IP estable al CT. Para imágenes de aplicación sin gestor de red,
Proxmox 9.2 ofrece red administrada por el host; decide entre esa modalidad y la
configuración interna según el bridge y la política del nodo.

Reglas mínimas:

- Permite entrada TCP `3000` al CT solo desde la IP del reverse proxy.
- Permite salida DNS, HTTPS y los endpoints de IA necesarios.
- No publiques `3000` directamente a Internet.
- Permite administración de Proxmox/SSH solo desde la red de gestión.
- Activa el firewall en Datacenter, nodo y CT según la política local; marcar
  `firewall=1` en la NIC no sustituye definir y habilitar reglas.

Ejemplo de Nginx en un proxy separado:

```nginx
server {
    listen 443 ssl http2;
    server_name <FQDN>;

    ssl_certificate /etc/letsencrypt/live/<FQDN>/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/<FQDN>/privkey.pem;

    client_max_body_size 64m;

    location / {
        proxy_pass http://<IP_DEL_CT>:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
    }
}
```

Con ese proxy, conserva `VOCAB_TRUST_PROXY=1`. Ajusta
`client_max_body_size` junto con `VOCAB_MAX_IMPORT_BYTES` y
`VOCAB_MAX_BACKUP_BYTES`; el proxy debe aceptar el mayor upload permitido.

## 7. Arranque y verificación

Activa el arranque automático, inicia y comprueba el CT:

```bash
pct set <CTID> --onboot 1
pct start <CTID>
pct status <CTID>
pct config <CTID>
```

La imagen declara un Docker `HEALTHCHECK`, pero **no se debe asumir que Proxmox
lo convierte en un estado health del CT** durante la conversión OCI. La prueba
operativa es una solicitud HTTP manual:

```bash
pct exec <CTID> -- node -e \
  "fetch('http://127.0.0.1:3000/api/health').then(async r=>{console.log(r.status,await r.text());process.exit(r.ok?0:1)}).catch(e=>{console.error(e.message);process.exit(1)})"
curl --fail --show-error http://<IP_DEL_CT>:3000/api/health
curl --fail --show-error https://<FQDN>/api/health
```

Observa la consola durante el primer arranque:

```bash
pct console <CTID>
```

También revisa las tareas y logs del nodo en la GUI. Un Application Container
envía stdout/stderr del proceso principal a la consola; no presupongas que hay
`systemd` o `journalctl` dentro de esta imagen.

Verificaciones funcionales:

1. `/api/health` responde `200` y reporta proceso y base en `ok`.
2. `/data/vocab.db` existe y pertenece a UID/GID `1000:1000` visto desde el CT.
3. El CT reinicia y conserva las tarjetas.
4. La interfaz abre mediante HTTPS y las escrituras exigen `ADMIN_TOKEN`.
5. Solo aparecen proveedores cuyas credenciales/configuración están completas.
6. El puerto `3000` no es accesible desde redes no autorizadas.

## 8. Rotar y revocar credenciales

La aplicación relee `AI_CREDENTIALS_FILE` en cada operación IA. Rota las claves
sin reiniciar mediante reemplazo atómico en el mismo directorio:

```bash
install -m 0400 -o <UID_HOST_MAPPED> -g <GID_HOST_MAPPED> \
  <ARCHIVO_NUEVO_VALIDADO> <HOST_SECRET_DIR>/credentials.json.new
mv -f <HOST_SECRET_DIR>/credentials.json.new \
  <HOST_SECRET_DIR>/credentials.json
```

No sobrescribas el archivo activo poco a poco. Después de rotar, ejecuta una
actualización de modelos desde Administración y comprueba que no haya `503`.

Para revocar todos los proveedores sin reiniciar, instala atómicamente un JSON
vacío válido:

```bash
printf '{}\n' > <HOST_SECRET_DIR>/credentials.json.new
chown <UID_HOST_MAPPED>:<GID_HOST_MAPPED> \
  <HOST_SECRET_DIR>/credentials.json.new
chmod 0400 <HOST_SECRET_DIR>/credentials.json.new
mv -f <HOST_SECRET_DIR>/credentials.json.new \
  <HOST_SECRET_DIR>/credentials.json
```

| Cambio | ¿Reinicio o recreación? |
|---|---|
| Claves dentro de `credentials.json` | No; se releen por operación |
| Revocación mediante `{}` | No |
| `ADMIN_TOKEN` | Sí; recrea/reinicia para cambiar el entorno del proceso |
| `AZURE_OPENAI_ENDPOINT` | Sí |
| `HOST`, `PORT`, `VOCAB_DB` u otra variable | Sí |
| Ruta `AI_CREDENTIALS_FILE` | Sí |
| Configuración de mount, CPU, RAM o red | Aplica el procedimiento indicado por Proxmox; normalmente requiere parar o reiniciar según el cambio |
| Contenido de un `VOCAB_CONFIG` montado | La configuración se relee en operaciones administrativas, pero valida el cambio; si cambia la ruta o el entorno, reinicia |

## 9. Backup y restore

### Copia consistente desde la aplicación

La copia primaria recomendada es **Administración → Carga de datos → Descargar
archivo SQLite**. La aplicación usa la API de backup de SQLite y produce una
copia consistente mientras continúa atendiendo solicitudes. La exportación JSON
solo contiene tarjetas; no reemplaza el backup SQLite completo.

Guarda la copia fuera del CT, cifra el almacenamiento y prueba periódicamente la
restauración. La restauración desde la interfaz valida integridad, versión y
tablas antes de reemplazar la base; sustituye tarjetas, auditoría, métricas,
estados de aprendizaje y configuración IA persistida. No restaura variables,
secretos, `config.json` ni archivos seed.

### `vzdump`

Configura un job de `vzdump` para el CT y verifica que el mount administrado de
`/data` tenga `backup=1`. Proxmox puede usar snapshots para obtener consistencia
cuando el storage lo soporta, pero el backup de aplicación sigue siendo el punto
de restauración portable y verificable para SQLite.

Un bind mount del host **no se incluye en `vzdump`**, aunque aparezca en la
configuración del CT. Esto afecta al directorio de secretos y a cualquier `/data`
que se haya implementado contra esta recomendación como bind mount.

No copies en caliente solo `vocab.db` con `cp`, `rsync` o snapshots parciales:
en modo WAL puede faltar información que siga en `vocab.db-wal`, y los archivos
WAL/SHM no deben combinarse desde instantes distintos. Usa el backup de la app o
detén limpiamente el CT antes de una copia filesystem coherente.

### Prueba de restore

1. Crea un CT aislado sin acceso público.
2. Despliega la misma versión de imagen.
3. Restaura el SQLite desde Administración.
4. Verifica health, conteos, ajustes y una lectura/escritura autenticada.
5. Destruye el entorno de prueba solo después de registrar el resultado.

## 10. Actualización y rollback OCI

Debido al estado *technology preview*, usa reemplazo de CT en vez de mutar la
imagen convertida en sitio:

1. Construye, prueba y publica un tag inmutable nuevo.
2. Descarga/importa esa referencia OCI en Proxmox.
3. Genera un backup SQLite consistente desde la aplicación vigente.
4. Crea un CT nuevo con otra IP y la misma configuración, sin apuntar ambos CT al
   mismo `/data`.
5. Restaura una copia de la base en un volumen `/data` nuevo.
6. Valida health y funciones mediante acceso interno.
7. Detén el CT anterior, realiza un backup final si hubo escrituras y sincroniza
   el punto de corte mediante el procedimiento de restore.
8. Cambia el upstream del reverse proxy al CT nuevo.
9. Conserva temporalmente el CT anterior apagado y su volumen para rollback.

Para rollback, vuelve el proxy al CT anterior o crea otro CT desde el tag/digest
anterior y restaura el backup compatible. Nunca arranques simultáneamente dos CT
contra el mismo volumen SQLite.

## Alternativa: Docker Compose dentro de un LXC de sistema

Esta ruta es independiente de OCI directo. Crea un LXC Debian o Ubuntu de
sistema, preferiblemente no privilegiado, e instala Docker Engine y el plugin
Compose siguiendo la documentación oficial de Docker para esa distribución.
Proxmox documenta que Docker anidado requiere `keyctl`, y `nesting` expone parte
de `procfs`/`sysfs` del host al guest; habilita solo las funciones necesarias y
mantén el CT no privilegiado.

Flujo conceptual:

1. Crea el LXC de sistema con 2 cores, 1024 MiB RAM, 512 MiB swap y 12 GiB de
   disco, con `nesting=1` y `keyctl=1` si la versión instalada lo requiere.
2. Instala Docker Engine desde su repositorio oficial y el plugin
   `docker-compose-plugin`.
3. Clona o copia el repositorio ya publicado dentro del LXC.
4. Crea `.env` a partir de `.env.example`; no lo confirmes en Git.
5. Crea el directorio de secretos y `credentials.json` con UID/GID `1000:1000`.
6. Construye y levanta exactamente una instancia.

`.env` mínimo de Compose:

```dotenv
ADMIN_TOKEN=<TOKEN_ADMINISTRATIVO_LARGO_Y_ALEATORIO>
AI_SECRETS_DIR=/srv/vocab-cards/secrets
VOCAB_BIND_ADDRESS=127.0.0.1
VOCAB_PORT=3000
VOCAB_TRUST_PROXY=1
```

Si el reverse proxy está fuera de ese LXC, `127.0.0.1` no será alcanzable.
Define una dirección de escucha apropiada y restringe el puerto mediante
firewall; no uses `0.0.0.0` sin reglas explícitas.

Prepara secretos y opera el servicio:

```bash
sudo install -d -m 0750 -o 1000 -g 1000 /srv/vocab-cards/secrets
sudo install -m 0400 -o 1000 -g 1000 \
  /dev/null /srv/vocab-cards/secrets/credentials.json
sudoedit /srv/vocab-cards/secrets/credentials.json

docker compose config
docker compose up -d --build
docker compose ps
docker compose logs --tail=200 app
```

El Compose monta un volumen Docker en `/data`, monta el directorio secreto en
solo lectura, ejecuta como `1000:1000`, usa rootfs de solo lectura y agrega un
`tmpfs` para `/tmp`. Su healthcheck consulta `/api/health` dentro del contenedor.

> **ADVERTENCIA SOBRE AZURE:** el `compose.yaml` actual **NO pasa
> `AZURE_OPENAI_ENDPOINT`** al contenedor. Azure funciona sin cambios en la ruta
> OCI directa cuando esa variable se configura en Proxmox y la API key está en
> `credentials.json`; la ruta Compose necesita ajustar su configuración antes de
> usarse con Azure. Esta guía no modifica `compose.yaml`.

Para aplicar cambios de `.env` o variables de Compose hay que recrear:

```bash
docker compose up -d --force-recreate
```

Las rotaciones atómicas de `credentials.json` no requieren recreación. Mantén
una sola réplica: no ejecutes `docker compose up --scale app=2`.

Antes de actualizar:

```bash
docker compose pull
docker compose build --pull
docker compose up -d
docker compose ps
docker compose logs --tail=200 app
```

No uses `docker compose down -v` salvo que quieras eliminar deliberadamente el
volumen `vocab-data` y perder la base persistida. `docker compose down` sin `-v`
conserva el volumen, pero un backup SQLite externo sigue siendo obligatorio.

## Troubleshooting

| Síntoma | Causa probable | Comprobación y corrección |
|---|---|---|
| CT arranca y termina inmediatamente | Entrypoint OCI no conservado o `/data` no escribible | Revisa consola, entrypoint y `stat /data`; usa el comando Node exacto de esta guía |
| `EACCES` en `/data/vocab.db` | UID/GID host-CT o mount point incorrecto | Verifica `id`, `stat`, offset/idmap y propietario; no uses `0777` |
| IA responde `503` | Archivo ausente, ilegible, inválido, con claves desconocidas o mayor a 16 KiB | Valida tamaño, JSON, allowlist, archivo regular y permisos desde UID 1000 |
| No aparecen proveedores | Falta clave específica o configuración requerida | Azure exige key + endpoint; custom/Ollama exigen `ai.providers` |
| Azure no aparece en OCI directo | Falta endpoint de entorno o key en el archivo | Verifica `AZURE_OPENAI_ENDPOINT` y `AZURE_OPENAI_API_KEY` sin imprimir la clave |
| Azure no aparece con Compose | El Compose actual no pasa el endpoint | Ajusta la configuración de Compose antes de usar Azure |
| Health interno funciona pero HTTPS no | Proxy, DNS o firewall | Prueba CT:3000 desde el proxy y revisa upstream, TLS y reglas |
| IP no se configura en Application Container | La imagen no incluye gestor de red | Evalúa red administrada por el host en Proxmox 9.2 |
| Cambio de entorno no tiene efecto | El proceso conserva el entorno inicial | Reinicia/recrea el CT; solo el archivo de credenciales se relee en caliente |
| Backup `vzdump` no contiene secretos o datos bind-mounted | Los bind mounts no se incluyen | Usa volumen administrado para `/data` y backup separado cifrado para secretos |
| El CT figura `running` pero la app falla | Estado LXC no equivale a health HTTP | Ejecuta manualmente `/api/health`; no confíes en la conversión del `HEALTHCHECK` |
| Restore muestra datos inesperados | Se restauró JSON o un snapshot parcial | Usa el SQLite completo generado por la app y valida en un CT aislado |

## Checklist final

- [ ] Los cambios de despliegue necesarios están publicados; el remoto no
      depende de cambios locales sin commit.
- [ ] `npm test`, `npm run build` y `docker build` pasan.
- [ ] La imagen usa un tag inmutable y se registró su digest.
- [ ] La arquitectura de imagen coincide con el nodo Proxmox.
- [ ] Se aceptó conscientemente el estado *technology preview* de OCI directo.
- [ ] El CT es no privilegiado, tiene 2 cores, 1024 MiB RAM y una sola réplica.
- [ ] `/data` es persistente, escribible por UID/GID 1000 y tiene backup.
- [ ] El directorio de secretos está montado de solo lectura y el mapeo de UID
      fue validado desde dentro del CT.
- [ ] `credentials.json` cumple allowlist, 16 KiB máximo y permisos restrictivos.
- [ ] `ADMIN_TOKEN` es largo, aleatorio y no aparece en Git ni logs de comandos.
- [ ] OCI directo usa `HOST`/`PORT`, no variables exclusivas de Compose.
- [ ] Azure tiene endpoint de entorno y key en el archivo, si se usa.
- [ ] Firewall permite `3000` únicamente desde el reverse proxy.
- [ ] TLS funciona y `VOCAB_TRUST_PROXY=1` está definido detrás del proxy.
- [ ] `/api/health` responde desde el CT, el proxy y el nombre público.
- [ ] Se verificó persistencia después de reiniciar.
- [ ] Existe un backup SQLite consistente fuera del CT y se probó su restore.
- [ ] `vzdump` incluye `/data`; los bind mounts tienen backup separado.
- [ ] La actualización y el rollback están ensayados con CT nuevos y tags
      inmutables.

## Referencias

- [Proxmox VE 9.2: Proxmox Container Toolkit](https://pve.proxmox.com/pve-docs/chapter-pct.html)
- [OCI Images en Proxmox Container Toolkit](https://pve.proxmox.com/pve-docs/chapter-pct.html#_open_container_initiative_oci_images)
- [Mount points y bind mounts en Proxmox](https://pve.proxmox.com/pve-docs/chapter-pct.html#pct_mount_points)
- [Backup y restore de contenedores](https://pve.proxmox.com/pve-docs/chapter-pct.html#pct_backup_restore)
