# Original Arena source-build acceptance fixture. SPDX-License-Identifier: MIT
extends Node2D
var score := 0
var save_path := ""
var audio: AudioStreamGeneratorPlayback
var phase := 0.0
func _ready():
	var profile = OS.get_environment("ARENA_ARCADE_PROFILE")
	if profile.is_empty():
		get_tree().quit(2)
		return
	save_path = profile.path_join("source-godot-score.txt")
	if FileAccess.file_exists(save_path):
		var saved = FileAccess.open(save_path, FileAccess.READ)
		score = maxi(0, int(saved.get_as_text()))
	var player = AudioStreamPlayer.new()
	var generator = AudioStreamGenerator.new()
	generator.mix_rate = 48000
	generator.buffer_length = 0.15
	player.stream = generator
	add_child(player)
	player.play()
	audio = player.get_stream_playback()
	queue_redraw()
func _input(event):
	if event.is_action_pressed("ui_cancel"):
		get_tree().quit()
	if event.is_action_pressed("ui_right") and not event.is_echo():
		score += 1
		var saved = FileAccess.open(save_path, FileAccess.WRITE)
		if saved == null:
			get_tree().quit(3)
			return
		saved.store_string(str(score))
		saved.close()
		queue_redraw()
func _process(_delta):
	if audio:
		for frame in range(audio.get_frames_available()):
			var value = sin(phase) * 0.035
			audio.push_frame(Vector2(value, value))
			phase += TAU * 440.0 / 48000.0
func _draw():
	draw_rect(Rect2(0, 0, 640, 360), Color(0.04, 0.06, 0.1))
	draw_string(ThemeDB.fallback_font, Vector2(24, 45), "Godot source build: Right moves and saves; Esc closes. Score: " + str(score), HORIZONTAL_ALIGNMENT_LEFT, -1, 20)
	draw_rect(Rect2(32 + (score % 24) * 20, 140, 32, 32), Color(0.12, 0.9, 0.35))
