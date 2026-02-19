form ExtractPitchToTsv
    sentence inputwav
    sentence outputtsv
    real timestep 0.01
    real pitchfloor 75
    real pitchceiling 500
endform

Read from file... 'inputwav$'
sound = selected("Sound")
duration = Get total duration

# Parameter order for Sound: To Pitch (ac)... is:
# timeStep, pitchFloor, maxCandidates, veryAccurate, silenceThreshold, voicingThreshold,
# octaveCost, octaveJumpCost, voicedUnvoicedCost, pitchCeiling
To Pitch (ac): timestep, pitchfloor, 15, "off", 0.03, 0.45, 0.01, 0.35, 0.14, pitchceiling
pitch = selected("Pitch")

if fileReadable (outputtsv$)
    filedelete 'outputtsv$'
endif
line$ = "t" + tab$ + "f0_hz" + newline$
fileappend 'outputtsv$' 'line$'

t = 0
while t <= duration
    f0 = Get value at time... t "Hertz" Linear
    if f0 = undefined
        line$ = string$(t) + tab$ + "NaN" + newline$
    else
        line$ = string$(t) + tab$ + string$(f0) + newline$
    endif
    fileappend 'outputtsv$' 'line$'
    t = t + timestep
endwhile

selectObject: sound
Remove
selectObject: pitch
Remove
