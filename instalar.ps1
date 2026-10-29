# Instalador do modpack Astral para Windows. No PowerShell (ou no Terminal do Windows):
#
#   irm https://astralmc.online/instalar.ps1 | iex
#
# Baixa o instalador, confere o SHA-256 publicado em channel/instalador.txt e o abre nesta janela.
# Um programa baixado pelo PowerShell nao passa pelo SmartScreen.
#
# O programa fica em %LOCALAPPDATA%\Astral, como fazem os instaladores do Scoop e do Bun, e e reaproveitado
# enquanto a versao publicada nao mudar. Um .exe de nome aleatorio rodando do TEMP e apagado em seguida e
# justamente o que os antivirus esperam de um programa malicioso.
& {
	$ErrorActionPreference = 'Stop'
	$ProgressPreference = 'SilentlyContinue' # A barra do Invoke-WebRequest deixa o download muito mais lento no PowerShell 5.
	[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

	function Falha($mensagem) {
		Write-Host ''
		Write-Host "x $mensagem" -ForegroundColor Red
		Write-Host ''
	}

	function FalhaAntivirus {
		Falha 'O antivirus bloqueou o instalador do Astral.'
		Write-Host '  Isso costuma ser um falso positivo com programas novos. Veja como instalar sem ele em'
		Write-Host '  https://astralmc.online/instalar.html#antivirus' -ForegroundColor Cyan
		Write-Host ''
	}

	# ERROR_VIRUS_INFECTED (225): o Windows Defender barrou o arquivo ao gravar ou ao executar.
	function Bloqueado($erro) {
		$excecao = $erro.Exception
		while ($excecao) {
			if ($excecao.HResult -eq -2147024671 -or $excecao.NativeErrorCode -eq 225) { return $true }
			$excecao = $excecao.InnerException
		}
		return $false
	}

	function Sha256($caminho) {
		(Get-FileHash -Algorithm SHA256 -LiteralPath $caminho).Hash.ToLowerInvariant()
	}

	$manifesto = if ($env:ASTRAL_MANIFESTO) { $env:ASTRAL_MANIFESTO } else { 'https://raw.githubusercontent.com/dvd-iso/astral-installer/main/channel/instalador.txt' }
	$processador = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
	switch ($processador) {
		'AMD64' { $alvo = 'windows-amd64' }
		'ARM64' { $alvo = 'windows-arm64' }
		default { Falha 'O Minecraft com o Astral precisa de um Windows 64 bits.'; return }
	}

	Write-Host 'Baixando o instalador do Astral...' -ForegroundColor DarkGray
	try {
		$texto = (Invoke-WebRequest -UseBasicParsing -Uri $manifesto).Content
		if ($texto -is [byte[]]) { $texto = [Text.Encoding]::UTF8.GetString($texto) }
	} catch {
		Falha 'Nao deu para falar com o GitHub. Confira sua internet e tente de novo.'; return
	}
	$campos = $null
	foreach ($item in ($texto -split "`n")) {
		$partes = $item.TrimEnd("`r") -split "`t"
		if ($partes.Count -ge 3 -and $partes[0] -eq $alvo) { $campos = $partes }
	}
	if (-not $campos) { Falha "Ainda nao ha instalador para $alvo."; return }
	$esperado = $campos[1].ToLowerInvariant()

	$base = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { [IO.Path]::GetTempPath() }
	$pasta = Join-Path $base 'Astral'
	$programa = Join-Path $pasta 'astral-instalador.exe'
	$pronto = $false
	try { $pronto = (Test-Path -LiteralPath $programa) -and (Sha256 $programa) -eq $esperado } catch { }

	if (-not $pronto) {
		$parcial = "$programa.part"
		try {
			New-Item -ItemType Directory -Force -Path $pasta | Out-Null
			Invoke-WebRequest -UseBasicParsing -Uri $campos[2] -OutFile $parcial
		} catch {
			Remove-Item -LiteralPath $parcial -Force -ErrorAction SilentlyContinue
			if (Bloqueado $_) { FalhaAntivirus } else { Falha 'O download do instalador falhou. Tente de novo.' }
			return
		}
		# O antivirus pode tirar o arquivo da pasta logo depois de gravado.
		if (-not (Test-Path -LiteralPath $parcial)) { FalhaAntivirus; return }
		try { $obtido = Sha256 $parcial } catch { FalhaAntivirus; return }
		if ($obtido -ne $esperado) {
			Remove-Item -LiteralPath $parcial -Force -ErrorAction SilentlyContinue
			Falha 'O instalador baixado nao confere com o publicado. Tente de novo.'; return
		}
		try {
			Move-Item -LiteralPath $parcial -Destination $programa -Force
		} catch {
			Remove-Item -LiteralPath $parcial -Force -ErrorAction SilentlyContinue
			Falha 'O instalador do Astral ja esta aberto em outra janela. Feche-o e rode o comando de novo.'; return
		}
	}

	try {
		& $programa
	} catch {
		if (Bloqueado $_) { FalhaAntivirus } else { Falha "Nao deu para abrir o instalador: $($_.Exception.Message)" }
	}
}
