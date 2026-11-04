; Build with build.cjs --compile <payload>; no global Node/PostgreSQL installation.
#ifndef PayloadDir
  #error PayloadDir must name a complete verified production payload
#endif
#ifndef ProgramBytes
  #error ProgramBytes must include actual payload and staging requirements
#endif
[Setup]
AppId=AccountExpress.SinglePC
AppName=AccountExpress
AppVersion=0.2.0
DefaultDirName={localappdata}\Programs\AccountExpress
DefaultGroupName=AccountExpress
DisableProgramGroupPage=yes
DisableDirPage=no
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=.checks\output
OutputBaseFilename=AccountExpress-Setup
Compression=lzma2/fast
SolidCompression=yes
WizardStyle=modern
CreateUninstallRegKey=no
Uninstallable=yes
AllowNoIcons=yes
CloseApplications=no
RestartApplications=no
SetupLogging=yes

[Languages]
Name: "es"; MessagesFile: "compiler:Languages\Spanish.isl"
Name: "en"; MessagesFile: "compiler:Default.isl"

[CustomMessages]
es.DataTitle=Carpeta de datos
es.DataDescription=Elegí dónde guardar tus datos contables.
es.DataPrompt=Los datos se conservan al desinstalar y deben estar fuera de la carpeta del programa.
es.InvalidDestination=No se puede instalar en esas carpetas. Revisá que estén vacías, separadas, sean locales y tengan espacio y permisos de escritura.
es.ConfigureFailed=No se pudo configurar la instalación. Los datos existentes no se sobrescribieron.
es.StartApp=Iniciar AccountExpress
es.StopFirst=Cerrá AccountExpress antes de desinstalar. No se pudo detener la instancia propia de forma segura.
en.DataTitle=Data directory
en.DataDescription=Choose where to store your accounting data.
en.DataPrompt=Data is retained on uninstall and must be separate from the program directory.
en.InvalidDestination=Cannot install in these directories. They must be empty, separate, local, writable and have sufficient free space.
en.ConfigureFailed=Installation configuration failed. Existing data was not overwritten.
en.StartApp=Start AccountExpress
en.StopFirst=Close AccountExpress before uninstalling. The owned runtime could not be stopped safely.

[Files]
Source: "{#PayloadDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "{#PayloadDir}\runtime\node\node.exe"; Flags: dontcopy
Source: "preflight.cjs"; Flags: dontcopy

[Icons]
Name: "{group}\AccountExpress"; Filename: "{app}\start.cmd"; WorkingDir: "{app}"
Name: "{group}\Detener AccountExpress"; Filename: "{app}\stop.cmd"; WorkingDir: "{app}"
Name: "{group}\Desinstalar AccountExpress"; Filename: "{uninstallexe}"

[Run]
Filename: "{app}\start.cmd"; Description: "{cm:StartApp}"; Flags: postinstall shellexec nowait skipifsilent

[UninstallDelete]
; Only the installation pointer is generated in app; never recursively remove {app} or data.
Type: files; Name: "{app}\.accountexpress-install.json"

[Code]
var
  DataPage: TInputDirWizardPage;
  PreflightExtracted: Boolean;

procedure InitializeWizard();
begin
  DataPage := CreateInputDirPage(wpSelectDir, CustomMessage('DataTitle'), CustomMessage('DataDescription'), CustomMessage('DataPrompt'), False, '');
  DataPage.Add('');
  DataPage.Values[0] := ExpandConstant('{param:DATADIR|{localappdata}\AccountExpress-data}');
end;

function ValidateDestinations(): Boolean;
var
  ExitCode: Integer;
  Args: String;
begin
  if not PreflightExtracted then begin
    ExtractTemporaryFile('node.exe');
    ExtractTemporaryFile('preflight.cjs');
    PreflightExtracted := True;
  end;
  Args := '"' + ExpandConstant('{tmp}\preflight.cjs') + '" --program-dir "' + WizardDirValue() + '" --data-dir "' + DataPage.Values[0] + '" --program-bytes {#ProgramBytes} --data-bytes 536870912';
  Result := Exec(ExpandConstant('{tmp}\node.exe'), Args, ExpandConstant('{tmp}'), SW_HIDE, ewWaitUntilTerminated, ExitCode);
  Result := Result and (ExitCode = 0);
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if CurPageID = DataPage.ID then begin
    Result := ValidateDestinations();
    if not Result then MsgBox(CustomMessage('InvalidDestination'), mbError, MB_OK);
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  if not ValidateDestinations() then Result := CustomMessage('InvalidDestination');
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ExitCode: Integer;
begin
  if CurStep = ssPostInstall then begin
    if not Exec(ExpandConstant('{app}\runtime\node\node.exe'), '"' + ExpandConstant('{app}\launcher.cjs') + '" --configure --data-dir "' + DataPage.Values[0] + '"', ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, ExitCode) then
      RaiseException(CustomMessage('ConfigureFailed'));
    if ExitCode <> 0 then RaiseException(CustomMessage('ConfigureFailed'));
  end;
end;

function InitializeUninstall(): Boolean;
var
  ExitCode: Integer;
begin
  Result := Exec(ExpandConstant('{app}\runtime\node\node.exe'), '"' + ExpandConstant('{app}\launcher.cjs') + '" --stop', ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, ExitCode);
  Result := Result and (ExitCode = 0);
  if not Result then MsgBox(CustomMessage('StopFirst'), mbError, MB_OK);
end;
