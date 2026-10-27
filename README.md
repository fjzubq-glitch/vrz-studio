# VRZ Studio

Grabador de pantalla de escritorio para clases y tutoriales. 
Desarrollado por Franklin Zaldaña · AI-assisted.

## Características
- Modo **Clase**: grabación de pantalla/ventana con recorte opcional.
- Modo **Tutorial**: captura de pantalla completa para incluir diálogos del sistema.
- Oculta la aplicación al iniciar grabación para evitar que aparezca en el vídeo.
- Sin transcripción local, sin IA en el cliente. Privado por diseño.

## Requisitos
- Windows 10/11 64-bit
- Espacio libre recomendado > 4 GB

## Uso rápido
1. Descomprime el portable.
2. Ejecuta `VRZ Studio.exe`.
3. Elige fuente y pulsa Grabar.

Atajos:
- `Ctrl+Shift+R` iniciar/detener
- `Ctrl+Shift+M` hablar / silenciar micrófono

## Build
```bash
npm install
npm run pack
```

El ejecutable se genera en `release/VRZ Studio-win32-x64/`. 
`ffmpeg.exe` debe copiarse junto al `.exe` después del pack.

## Releases
Los binarios portables se publican en Releases de GitHub.
- `VRZ Studio Portable x64.zip` → versión completa
- `VRZ Studio II Portable x64.zip` → versión Clase-only para compartir

## Licencia
Ver `LICENSE`.

## Créditos
Built by Franklin Zaldaña · AI-assisted
