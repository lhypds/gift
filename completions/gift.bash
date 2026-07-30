# gift-completion — bash completion for the gift CLI. Installed by ./install.sh,
# removed by ./uninstall.sh. Command names come from `gift commands`, so new
# command folders complete without touching this file.
#
# Load it by hand with:  source /path/to/gift/completions/gift.bash

_gift_complete() {
    local cur prev
    cur="${COMP_WORDS[COMP_CWORD]}"
    prev="${COMP_WORDS[COMP_CWORD - 1]}"
    COMPREPLY=()

    if [[ $COMP_CWORD -eq 2 && "$prev" == "completion" ]]; then
        COMPREPLY=($(compgen -W "zsh bash" -- "$cur"))
        return 0
    fi

    if [[ $COMP_CWORD -eq 1 || ($COMP_CWORD -eq 2 && "$prev" == "help") ]]; then
        COMPREPLY=($(compgen -W "$(gift commands 2>/dev/null)" -- "$cur"))
        return 0
    fi

    COMPREPLY=($(compgen -f -- "$cur"))
    return 0
}

complete -F _gift_complete gift
