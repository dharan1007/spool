{{- define "spool.name" -}}
spool-enterprise
{{- end -}}

{{- define "spool.fullname" -}}
{{- printf "%s-%s" .Release.Name (include "spool.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "spool.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{ include "spool.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "spool.selectorLabels" -}}
app.kubernetes.io/name: {{ include "spool.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "spool.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "spool.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "spool.validate" -}}
{{- if gt (int .Values.replicaCount) 1 -}}
{{- fail "SPOOL state is a single-writer SQLite volume; replicaCount must be 1" -}}
{{- end -}}
{{- if not (regexMatch "^[a-f0-9]{40}$" (toString .Values.release.commitSha)) -}}
{{- fail "release.commitSha must be the exact 40-character lowercase release commit" -}}
{{- end -}}
{{- if ne .Values.release.version "1.1.2" -}}
{{- fail "release.version must match the shipped production policy release 1.1.2" -}}
{{- end -}}
{{- if not .Values.credentialsSecretName -}}
{{- fail "credentialsSecretName is required; credentials are never templated" -}}
{{- end -}}
{{- end -}}
