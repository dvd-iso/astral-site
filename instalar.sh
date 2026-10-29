#!/bin/sh
# Instalador do modpack Astral para macOS e Linux. No Terminal:
#
#   curl -fsSL https://astralmc.online/instalar.sh | sh
#
# Baixa o instalador do seu sistema, confere o SHA-256 publicado em channel/instalador.txt e o abre neste terminal.
# Nada fica instalado além do modpack: o programa é apagado ao terminar.
set -eu

MANIFESTO="${ASTRAL_MANIFESTO:-https://raw.githubusercontent.com/dvd-iso/astral-installer/main/channel/instalador.txt}"

falha() {
	printf '\n\033[1;31m✗\033[0m %s\n\n' "$1" >&2
	exit 1
}

baixar() {
	if command -v curl >/dev/null 2>&1; then
		curl -fsSL --retry 3 --connect-timeout 20 -o "$2" "$1"
	elif command -v wget >/dev/null 2>&1; then
		wget -q --tries=3 --timeout=20 -O "$2" "$1"
	else
		falha "Instale o curl e rode o comando de novo."
	fi
}

sha256() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | cut -d ' ' -f 1
	else
		shasum -a 256 "$1" | cut -d ' ' -f 1
	fi
}

# Tudo fica numa função: se a conexão cair no meio do download deste script, nada roda pela metade.
principal() {
	case "$(uname -s)" in
		Darwin) sistema=darwin ;;
		Linux) sistema=linux ;;
		*) falha "Sistema não suportado. No Windows, use o comando do PowerShell em astralmc.online/instalar." ;;
	esac
	case "$(uname -m)" in
		x86_64 | amd64) arquitetura=amd64 ;;
		arm64 | aarch64) arquitetura=arm64 ;;
		*) falha "Processador não suportado: $(uname -m)." ;;
	esac
	# Um terminal rodando no Rosetta diz x86_64 num Mac com Apple Silicon.
	if [ "$sistema" = darwin ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ]; then
		arquitetura=arm64
	fi
	if ! (: </dev/tty) 2>/dev/null; then
		falha "O instalador precisa de um terminal. Abra o Terminal e cole o comando lá."
	fi

	pasta=$(mktemp -d 2>/dev/null || mktemp -d -t astral)
	trap 'rm -rf "$pasta"' EXIT
	trap 'exit 130' INT TERM

	printf '\033[2mBaixando o instalador do Astral…\033[0m\n'
	baixar "$MANIFESTO" "$pasta/manifesto.txt" || falha "Não deu para falar com o GitHub. Confira sua internet e tente de novo."
	linha=$(awk -F '\t' -v alvo="$sistema-$arquitetura" '$1 == alvo { print $2 " " $3 }' "$pasta/manifesto.txt")
	[ -n "$linha" ] || falha "Ainda não há instalador para $sistema-$arquitetura."
	esperado=${linha%% *}
	endereco=${linha#* }
	baixar "$endereco" "$pasta/astral" || falha "O download do instalador falhou. Tente de novo."
	[ "$(sha256 "$pasta/astral")" = "$esperado" ] || falha "O instalador baixado não confere com o publicado. Tente de novo."
	chmod +x "$pasta/astral"

	status=0
	"$pasta/astral" "$@" </dev/tty || status=$?
	return "$status"
}

principal "$@"
