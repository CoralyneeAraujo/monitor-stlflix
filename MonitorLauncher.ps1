# === CONFIGURAÇÃO (AJUSTE) ===
$NodeExe   = "C:\Program Files\nodejs\node.exe"            # caminho do node.exe
$ProjectDir= "C:\Users\Caroline\Desktop\Monitoramento"                 # pasta do projeto
$EntryFile = "server.js"                                   # arquivo de entrada (ex: server.js/index.js)
$Url       = "http://localhost:3000"                       # URL da sua app

# === NÃO ALTERAR DAQUI PRA BAIXO ===
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$Form                  = New-Object System.Windows.Forms.Form
$Form.Text             = "Monitoramento (porta 3000)"
$Form.Size             = New-Object System.Drawing.Size(420,200)
$Form.StartPosition    = "CenterScreen"
$Form.Topmost          = $true

$btnStart              = New-Object System.Windows.Forms.Button
$btnStart.Text         = "Iniciar monitoramento"
$btnStart.Size         = New-Object System.Drawing.Size(170,40)
$btnStart.Location     = New-Object System.Drawing.Point(25,25)

$btnStop               = New-Object System.Windows.Forms.Button
$btnStop.Text          = "Parar"
$btnStop.Size          = New-Object System.Drawing.Size(120,40)
$btnStop.Location      = New-Object System.Drawing.Point(210,25)
$btnStop.Enabled       = $false

$lblStatus             = New-Object System.Windows.Forms.Label
$lblStatus.AutoSize    = $true
$lblStatus.Location    = New-Object System.Drawing.Point(25,85)
$lblStatus.Font        = New-Object System.Drawing.Font("Segoe UI",10,[System.Drawing.FontStyle]::Regular)
$lblStatus.Text        = "Parado"

$pb                    = New-Object System.Windows.Forms.ProgressBar
$pb.Style              = "Continuous"
$pb.Size               = New-Object System.Drawing.Size(340,16)
$pb.Location           = New-Object System.Drawing.Point(25,120)
$pb.Minimum            = 0
$pb.Maximum            = 100
$pb.Value              = 0

$Form.Controls.AddRange(@($btnStart,$btnStop,$lblStatus,$pb))

$global:ServerProcess = $null

function Is-Port-Listening($port){
  try {
    $conn = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction Stop
    return $conn -ne $null
  } catch { return $false }
}

function Start-Server {
  if (-not (Test-Path $NodeExe))          { [System.Windows.Forms.MessageBox]::Show("Node não encontrado: `n$NodeExe"); return }
  if (-not (Test-Path $ProjectDir))       { [System.Windows.Forms.MessageBox]::Show("Pasta do projeto não existe: `n$ProjectDir"); return }
  if (-not (Test-Path (Join-Path $ProjectDir $EntryFile))) { [System.Windows.Forms.MessageBox]::Show("EntryPoint não existe: `n$EntryFile"); return }

  Push-Location $ProjectDir
  try {
    # se já estiver algo na 3000, avisa
    if (Is-Port-Listening 3000) {
      $res = [System.Windows.Forms.MessageBox]::Show("A porta 3000 já está em uso. Mesmo assim abrir o navegador para $Url?","Aviso",[System.Windows.Forms.MessageBoxButtons]::YesNo)
      if ($res -eq "Yes") { Start-Process $Url }
      return
    }

    $lblStatus.Text = "Iniciando..."
    $pb.Value = 20

    $psi                       = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName              = $NodeExe
    $psi.Arguments             = $EntryFile
    $psi.WorkingDirectory      = $ProjectDir
    $psi.UseShellExecute       = $false
    $psi.CreateNoWindow        = $true
    $psi.RedirectStandardOutput= $true
    $psi.RedirectStandardError = $true

    $p = New-Object System.Diagnostics.Process
    $p.StartInfo = $psi
    $null = $p.Start()

    $global:ServerProcess = $p
    $btnStart.Enabled = $false
    $btnStop.Enabled  = $true

    $lblStatus.Text = "Subindo servidor..."
    $pb.Value = 60

    Start-Sleep -Seconds 3

    # Tenta detectar se já está ouvindo na 3000
    $tries = 0
    while (-not (Is-Port-Listening 3000) -and $tries -lt 20 -and -not $p.HasExited) {
      Start-Sleep -Milliseconds 500
      $tries++
    }

    if ($p.HasExited) {
      $out = $p.StandardError.ReadToEnd() + "`n" + $p.StandardOutput.ReadToEnd()
      $lblStatus.Text = "Falhou ao iniciar (processo saiu)."
      $pb.Value = 0
      $btnStart.Enabled = $true
      $btnStop.Enabled  = $false
      [System.Windows.Forms.MessageBox]::Show("O servidor encerrou ao iniciar.`nLogs:`n`n$out","Erro")
      return
    }

    if (Is-Port-Listening 3000) {
      $lblStatus.Text = "Rodando em $Url"
      $pb.Value = 100
      Start-Process $Url
    } else {
      $lblStatus.Text = "Rodando (porta não confirmada)"
      $pb.Value = 80
      Start-Process $Url
    }
  } finally {
    Pop-Location
  }
}

function Stop-Server {
  try {
    if ($global:ServerProcess -and -not $global:ServerProcess.HasExited) {
      $global:ServerProcess.Kill()
      $global:ServerProcess.WaitForExit()
    } else {
      # fallback: tenta matar qualquer node que esteja usando a 3000
      $conns = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
      if ($conns) {
        foreach ($c in $conns) {
          $pid = $c.OwningProcess
          if ($pid) {
            try { Stop-Process -Id $pid -Force -ErrorAction Stop } catch {}
          }
        }
      }
    }
  } catch {
    [System.Windows.Forms.MessageBox]::Show("Erro ao parar: $($_.Exception.Message)")
  } finally {
    $global:ServerProcess = $null
    $btnStart.Enabled = $true
    $btnStop.Enabled  = $false
    $lblStatus.Text   = "Parado"
    $pb.Value         = 0
  }
}

$btnStart.Add_Click({ Start-Server })
$btnStop.Add_Click({  Stop-Server  })

$Form.Add_FormClosing({
  # encerra o servidor se a janela for fechada
  if ($global:ServerProcess -and -not $global:ServerProcess.HasExited) {
    Stop-Server
  }
})

[void]$Form.ShowDialog()
