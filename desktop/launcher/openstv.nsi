; OpenSTV: однофайловый запускатель.
;
; Первый запуск распаковывает приложение в %LOCALAPPDATA%\OpenSTV\<версия>
; и запускает его. Следующие запуски используют уже распакованную копию:
; распаковка не повторяется, окно прогресса не показывается.
;
; Именно поэтому здесь свой NSIS-скрипт, а не target `portable` из
; electron-builder: тот распаковывает приложение во временную папку, удаляет
; её перед каждым запуском и после выхода, из-за чего второй запуск убивает
; файлы работающего экземпляра.
;
; Файл сохранён в UTF-8 с BOM: иначе NSIS читает его как CP1251 и русский
; текст в ресурсе версии и в окне прогресса превращается в «кракозябры».
;
; Параметры сборки (см. build.mjs):
;   /DOUTFILE=<путь к готовому exe>
;   /DSOURCEDIR=<путь к win-unpacked>
;   /DICON=<путь к icon.ico>
;   /DAPPVERSION=<x.y.z>

Unicode true
SetCompressor /SOLID lzma
SetCompressorDictSize 64

!include "MUI2.nsh"

!define MUI_ICON "${ICON}"

Name "OpenSTV"
Caption "OpenSTV"
OutFile "${OUTFILE}"
Icon "${ICON}"
BrandingText "OpenSTV"
RequestExecutionLevel user
AutoCloseWindow true
ShowInstDetails nevershow
SilentInstall normal

InstallDir "$LOCALAPPDATA\OpenSTV\${APPVERSION}"

VIProductVersion "${APPVERSION}.0"
VIAddVersionKey "ProductName" "OpenSTV"
VIAddVersionKey "FileDescription" "OpenSTV — пакетная обработка OTDR-трасс (SOR)"
VIAddVersionKey "FileVersion" "${APPVERSION}"
VIAddVersionKey "ProductVersion" "${APPVERSION}"
VIAddVersionKey "LegalCopyright" "OpenSTV"
VIAddVersionKey "OriginalFilename" "OpenSTV.exe"

!define MUI_PAGE_HEADER_TEXT "OpenSTV"
!define MUI_PAGE_HEADER_SUBTEXT "Первый запуск: подготовка файлов программы…"
!define MUI_INSTFILESPAGE_PROGRESSBAR smooth
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfReady
!insertmacro MUI_PAGE_INSTFILES

!insertmacro MUI_LANGUAGE "Russian"

Var Marker

; Уже распаковано: работаем без окна и без страницы прогресса.
Function .onInit
  IfFileExists "$INSTDIR\.complete" 0 init_done
    SetSilent silent
  init_done:
FunctionEnd

Function SkipIfReady
  IfFileExists "$INSTDIR\.complete" 0 skip_done
    Abort
  skip_done:
FunctionEnd

Section "-OpenSTV"
  IfFileExists "$INSTDIR\.complete" unpack_done
    RMDir /r "$INSTDIR"
    CreateDirectory "$INSTDIR"
    SetOutPath "$INSTDIR"
    File /r "${SOURCEDIR}\*.*"
    FileOpen $Marker "$INSTDIR\.complete" w
    FileClose $Marker
  unpack_done:
SectionEnd

Function .onInstSuccess
  Exec '"$INSTDIR\OpenSTV.exe"'
FunctionEnd
